import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";

import { PrismaService } from "@/prisma/prisma.service";
import { AppException } from "@/common/errors/app.exception";
import { AuditService } from "@/common/services/audit.service";
import type { AuthenticatedUser } from "@/common/decorators/auth.decorators";
import { CONFIG_NAMESPACES } from "./dto/settings.dto";
import type {
  BulkConfigDto,
  SetConfigDto,
  UpsertBannerDto,
  UpsertFaqDto,
  UpsertPageDto,
} from "./dto/settings.dto";

type Ctx = { ip?: string; requestId?: string };

@Injectable()
export class SettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Only genuine configuration — the per-user zone scope rows are not that. */
  private configOnly(): Prisma.SystemConfigWhereInput {
    return { OR: CONFIG_NAMESPACES.map((ns) => ({ key: { startsWith: `${ns}.` } })) };
  }

  async listConfig() {
    const rows = await this.prisma.systemConfig.findMany({
      where: this.configOnly(),
      orderBy: { key: "asc" },
    });

    // Grouped by namespace so a settings screen can render sections without
    // knowing the key list in advance.
    const grouped: Record<string, { key: string; value: unknown; updatedAt: Date; updatedBy: string | null }[]> = {};
    for (const row of rows) {
      const namespace = row.key.split(".")[0];
      (grouped[namespace] ??= []).push({
        key: row.key,
        value: row.value,
        updatedAt: row.updatedAt,
        updatedBy: row.updatedBy,
      });
    }
    return { count: rows.length, namespaces: grouped };
  }

  async setConfig(key: string, dto: SetConfigDto, actor: AuthenticatedUser, ctx: Ctx) {
    const before = await this.prisma.systemConfig.findUnique({ where: { key } });

    const after = await this.prisma.systemConfig.upsert({
      where: { key },
      create: { key, value: dto.value as Prisma.InputJsonValue, updatedBy: actor.id },
      update: { value: dto.value as Prisma.InputJsonValue, updatedBy: actor.id },
    });

    await this.audit.record({
      actor,
      action: "CONFIG_UPDATE",
      entity: "SystemConfig",
      entityId: key,
      before: before ? { value: before.value } : null,
      after: { value: after.value, reason: dto.reason },
      ...ctx,
    });

    return after;
  }

  /** A settings screen saves a whole section at once; so does this. */
  async setConfigBulk(dto: BulkConfigDto, actor: AuthenticatedUser, ctx: Ctx) {
    const keys = dto.entries.map((e) => e.key);
    const before = await this.prisma.systemConfig.findMany({ where: { key: { in: keys } } });
    const beforeBy = new Map(before.map((b) => [b.key, b.value]));

    await this.prisma.$transaction(
      dto.entries.map((entry) =>
        this.prisma.systemConfig.upsert({
          where: { key: entry.key },
          create: { key: entry.key, value: entry.value as Prisma.InputJsonValue, updatedBy: actor.id },
          update: { value: entry.value as Prisma.InputJsonValue, updatedBy: actor.id },
        }),
      ),
    );

    await this.audit.record({
      actor,
      action: "CONFIG_BULK_UPDATE",
      entity: "SystemConfig",
      entityId: keys.join(","),
      before: Object.fromEntries(beforeBy),
      after: {
        ...Object.fromEntries(dto.entries.map((e) => [e.key, e.value])),
        reason: dto.reason,
      },
      ...ctx,
    });

    return { updated: dto.entries.length, keys };
  }

  async listPages(includeDrafts: boolean) {
    return this.prisma.cmsPage.findMany({
      where: includeDrafts ? {} : { publishedAt: { not: null } },
      orderBy: { slug: "asc" },
    });
  }

  async getPage(slug: string, includeDrafts: boolean) {
    const page = await this.prisma.cmsPage.findUnique({ where: { slug } });
    if (!page || (!includeDrafts && !page.publishedAt)) throw AppException.notFound("page");
    return page;
  }

  async upsertPage(dto: UpsertPageDto, actor: AuthenticatedUser, ctx: Ctx) {
    const before = await this.prisma.cmsPage.findUnique({ where: { slug: dto.slug } });

    const page = await this.prisma.cmsPage.upsert({
      where: { slug: dto.slug },
      create: {
        slug: dto.slug,
        title: dto.title,
        bodyHtml: dto.bodyHtml,
        publishedAt: dto.publish ? new Date() : null,
        updatedBy: actor.id,
      },
      update: {
        title: dto.title,
        bodyHtml: dto.bodyHtml,
        // Publishing stamps a date; unpublishing clears it. Editing a live page
        // keeps the original publication date.
        publishedAt: dto.publish ? (before?.publishedAt ?? new Date()) : null,
        updatedBy: actor.id,
      },
    });

    await this.audit.record({
      actor,
      action: before ? "CMS_PAGE_UPDATE" : "CMS_PAGE_CREATE",
      entity: "CmsPage",
      entityId: dto.slug,
      before: before ? { title: before.title, publishedAt: before.publishedAt } : null,
      after: { title: page.title, publishedAt: page.publishedAt },
      ...ctx,
    });

    return page;
  }

  async removePage(slug: string, actor: AuthenticatedUser, ctx: Ctx) {
    const page = await this.prisma.cmsPage.findUnique({ where: { slug } });
    if (!page) throw AppException.notFound("page");

    await this.prisma.cmsPage.delete({ where: { slug } });

    await this.audit.record({
      actor,
      action: "CMS_PAGE_DELETE",
      entity: "CmsPage",
      entityId: slug,
      before: { title: page.title, publishedAt: page.publishedAt },
      ...ctx,
    });

    return { deleted: true, slug };
  }

  async listFaqs(includeInactive: boolean) {
    return this.prisma.faq.findMany({
      where: includeInactive ? {} : { isActive: true },
      orderBy: [{ category: "asc" }, { sortOrder: "asc" }],
    });
  }

  async createFaq(dto: UpsertFaqDto, actor: AuthenticatedUser, ctx: Ctx) {
    const faq = await this.prisma.faq.create({ data: dto });
    await this.audit.record({
      actor,
      action: "CMS_FAQ_CREATE",
      entity: "Faq",
      entityId: faq.id,
      after: { question: faq.question },
      ...ctx,
    });
    return faq;
  }

  async updateFaq(id: string, dto: Partial<UpsertFaqDto>, actor: AuthenticatedUser, ctx: Ctx) {
    const before = await this.prisma.faq.findUnique({ where: { id } });
    if (!before) throw AppException.notFound("FAQ");

    const after = await this.prisma.faq.update({ where: { id }, data: dto });
    await this.audit.record({
      actor,
      action: "CMS_FAQ_UPDATE",
      entity: "Faq",
      entityId: id,
      before,
      after,
      ...ctx,
    });
    return after;
  }

  async removeFaq(id: string, actor: AuthenticatedUser, ctx: Ctx) {
    const faq = await this.prisma.faq.findUnique({ where: { id } });
    if (!faq) throw AppException.notFound("FAQ");

    await this.prisma.faq.delete({ where: { id } });
    await this.audit.record({
      actor,
      action: "CMS_FAQ_DELETE",
      entity: "Faq",
      entityId: id,
      before: { question: faq.question },
      ...ctx,
    });
    return { deleted: true, id };
  }

  /** What the apps ask for: banners live right now, for this audience. */
  async liveBanners(audience: "CITIZEN" | "VENDOR") {
    const now = new Date();
    return this.prisma.banner.findMany({
      where: {
        isActive: true,
        startAt: { lte: now },
        endAt: { gte: now },
        audience: { in: [audience, "ALL"] },
      },
      orderBy: { startAt: "desc" },
    });
  }

  async listBanners() {
    return this.prisma.banner.findMany({ orderBy: { startAt: "desc" } });
  }

  async createBanner(dto: UpsertBannerDto, actor: AuthenticatedUser, ctx: Ctx) {
    const banner = await this.prisma.banner.create({ data: dto });
    await this.audit.record({
      actor,
      action: "CMS_BANNER_CREATE",
      entity: "Banner",
      entityId: banner.id,
      after: { title: banner.title, audience: banner.audience, startAt: banner.startAt, endAt: banner.endAt },
      ...ctx,
    });
    return banner;
  }

  async updateBanner(id: string, dto: Partial<UpsertBannerDto>, actor: AuthenticatedUser, ctx: Ctx) {
    const before = await this.prisma.banner.findUnique({ where: { id } });
    if (!before) throw AppException.notFound("banner");

    const after = await this.prisma.banner.update({ where: { id }, data: dto });
    await this.audit.record({
      actor,
      action: "CMS_BANNER_UPDATE",
      entity: "Banner",
      entityId: id,
      before,
      after,
      ...ctx,
    });
    return after;
  }

  async removeBanner(id: string, actor: AuthenticatedUser, ctx: Ctx) {
    const banner = await this.prisma.banner.findUnique({ where: { id } });
    if (!banner) throw AppException.notFound("banner");

    await this.prisma.banner.delete({ where: { id } });
    await this.audit.record({
      actor,
      action: "CMS_BANNER_DELETE",
      entity: "Banner",
      entityId: id,
      before: { title: banner.title },
      ...ctx,
    });
    return { deleted: true, id };
  }
}
