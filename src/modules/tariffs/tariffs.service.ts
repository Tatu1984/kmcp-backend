import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";

import { PrismaService } from "@/prisma/prisma.service";
import { AppException } from "@/common/errors/app.exception";
import { AuditService } from "@/common/services/audit.service";
import { Paginated } from "@/common/interceptors/response.interceptor";
import { orderBy, skipTake } from "@/common/dto/pagination.dto";
import type { AuthenticatedUser } from "@/common/decorators/auth.decorators";
import { QuoteService, ruleLabel } from "./quote.service";
import type {
  CreateDiscountDto,
  CreateHolidayDto,
  CreateTariffDto,
  PreviewQuoteDto,
  PublishTariffDto,
  TariffQueryDto,
  UpdateTariffDto,
} from "./dto/tariff.dto";

const SORTABLE = ["name", "effectiveFrom", "createdAt", "priority"] as const;

@Injectable()
export class TariffsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly quotes: QuoteService,
  ) {}

  async list(query: TariffQueryDto) {
    const where: Prisma.TariffWhereInput = {
      ...(query.zoneId ? { zoneId: query.zoneId } : {}),
      ...(query.vehicleType ? { vehicleTypeId: query.vehicleType } : {}),
      ...(query.published !== undefined ? { isPublished: query.published } : {}),
      ...(query.q ? { name: { contains: query.q, mode: "insensitive" } } : {}),
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.tariff.findMany({
        where,
        include: {
          rules: true,
          zone: { select: { id: true, code: true, name: true } },
          _count: { select: { sessions: true } },
        },
        orderBy: orderBy(query.sort, SORTABLE, { effectiveFrom: "desc" }),
        ...skipTake(query),
      }),
      this.prisma.tariff.count({ where }),
    ]);

    return new Paginated(items, query.page, query.pageSize, total);
  }

  async findOne(id: string) {
    const tariff = await this.prisma.tariff.findUnique({
      where: { id },
      include: { rules: true, zone: { select: { id: true, code: true, name: true } } },
    });
    if (!tariff) throw AppException.notFound("tariff");
    return tariff;
  }

  async create(dto: CreateTariffDto, user: AuthenticatedUser, ctx: { ip?: string; requestId?: string }) {
    const tariff = await this.prisma.tariff.create({
      data: {
        name: dto.name,
        zoneId: dto.zoneId,
        vehicleTypeId: dto.vehicleType,
        baseAmount: dto.baseAmount,
        baseMinutes: dto.baseMinutes,
        incrementAmount: dto.incrementAmount,
        incrementMinutes: dto.incrementMinutes,
        dailyCapAmount: dto.dailyCapAmount,
        gracePeriodMin: dto.gracePeriodMin,
        overstayPenalty: dto.overstayPenalty,
        taxPercent: new Prisma.Decimal(dto.taxPercent),
        effectiveFrom: dto.effectiveFrom,
        effectiveTo: dto.effectiveTo,
        priority: dto.priority,
        isPublished: false,
        rules: {
          create: dto.rules.map((r) => ({
            type: r.type,
            dayType: r.dayType,
            timeFrom: r.timeFrom,
            timeTo: r.timeTo,
            multiplier: r.multiplier !== undefined ? new Prisma.Decimal(r.multiplier) : null,
            flatAmount: r.flatAmount,
            priority: r.priority,
            isActive: r.isActive,
          })),
        },
      },
      include: { rules: true },
    });

    await this.audit.record({
      actor: user,
      action: "TARIFF_CREATE",
      entity: "Tariff",
      entityId: tariff.id,
      after: { name: tariff.name, vehicleType: tariff.vehicleTypeId, published: false },
      ...ctx,
    });

    return tariff;
  }

  /**
   * A published version is immutable. Editing one produces a new draft instead,
   * so any historic session can still be re-priced exactly as it was charged.
   */
  async update(
    id: string,
    dto: UpdateTariffDto,
    user: AuthenticatedUser,
    ctx: { ip?: string; requestId?: string },
  ) {
    const existing = await this.prisma.tariff.findUnique({ where: { id }, include: { rules: true } });
    if (!existing) throw AppException.notFound("tariff");

    if (existing.isPublished) {
      throw new AppException(
        "TARIFF_ALREADY_PUBLISHED",
        undefined,
        "This version is published. Duplicate it to create a new draft instead.",
      );
    }

    const { rules, vehicleType, taxPercent, ...rest } = dto;

    const updated = await this.prisma.$transaction(async (tx) => {
      if (rules) {
        await tx.tariffRule.deleteMany({ where: { tariffId: id } });
        await tx.tariffRule.createMany({
          data: rules.map((r) => ({
            tariffId: id,
            type: r.type,
            dayType: r.dayType,
            timeFrom: r.timeFrom,
            timeTo: r.timeTo,
            multiplier: r.multiplier !== undefined ? new Prisma.Decimal(r.multiplier) : null,
            flatAmount: r.flatAmount,
            priority: r.priority,
            isActive: r.isActive,
          })),
        });
      }

      return tx.tariff.update({
        where: { id },
        data: {
          ...rest,
          ...(vehicleType ? { vehicleTypeId: vehicleType } : {}),
          ...(taxPercent !== undefined ? { taxPercent: new Prisma.Decimal(taxPercent) } : {}),
        },
        include: { rules: true },
      });
    });

    await this.audit.record({
      actor: user,
      action: "TARIFF_UPDATE",
      entity: "Tariff",
      entityId: id,
      before: existing,
      after: updated,
      ...ctx,
    });

    return updated;
  }

  async duplicate(id: string, user: AuthenticatedUser, ctx: { ip?: string; requestId?: string }) {
    const source = await this.prisma.tariff.findUnique({ where: { id }, include: { rules: true } });
    if (!source) throw AppException.notFound("tariff");

    const copy = await this.prisma.tariff.create({
      data: {
        name: `${source.name} (draft)`,
        zoneId: source.zoneId,
        vehicleTypeId: source.vehicleTypeId,
        baseAmount: source.baseAmount,
        baseMinutes: source.baseMinutes,
        incrementAmount: source.incrementAmount,
        incrementMinutes: source.incrementMinutes,
        dailyCapAmount: source.dailyCapAmount,
        gracePeriodMin: source.gracePeriodMin,
        overstayPenalty: source.overstayPenalty,
        taxPercent: source.taxPercent,
        effectiveFrom: source.effectiveFrom,
        priority: source.priority + 1,
        isPublished: false,
        rules: {
          create: source.rules.map((r) => ({
            type: r.type,
            dayType: r.dayType,
            timeFrom: r.timeFrom,
            timeTo: r.timeTo,
            multiplier: r.multiplier,
            flatAmount: r.flatAmount,
            priority: r.priority,
            isActive: r.isActive,
          })),
        },
      },
      include: { rules: true },
    });

    await this.audit.record({
      actor: user,
      action: "TARIFF_DUPLICATE",
      entity: "Tariff",
      entityId: copy.id,
      after: { copiedFrom: id, name: copy.name },
      ...ctx,
    });

    return copy;
  }

  async publish(
    id: string,
    dto: PublishTariffDto,
    user: AuthenticatedUser,
    ctx: { ip?: string; requestId?: string },
  ) {
    const tariff = await this.prisma.tariff.findUnique({ where: { id } });
    if (!tariff) throw AppException.notFound("tariff");
    if (tariff.isPublished) throw new AppException("TARIFF_ALREADY_PUBLISHED");

    const published = await this.prisma.tariff.update({
      where: { id },
      data: { isPublished: true, publishedBy: user.id },
      include: { rules: true },
    });

    await this.audit.record({
      actor: user,
      action: "TARIFF_PUBLISH",
      entity: "Tariff",
      entityId: id,
      before: { isPublished: false },
      after: { isPublished: true, approvalReference: dto.approvalReference },
      ...ctx,
    });

    return { ...published, approvalReference: dto.approvalReference };
  }

  async archive(id: string, reason: string, user: AuthenticatedUser, ctx: { ip?: string; requestId?: string }) {
    const tariff = await this.prisma.tariff.findUnique({ where: { id } });
    if (!tariff) throw AppException.notFound("tariff");

    // Never deleted — historic charges must stay explainable. Closing the
    // effective window stops it applying to anything new.
    const archived = await this.prisma.tariff.update({
      where: { id },
      data: { effectiveTo: new Date() },
    });

    await this.audit.record({
      actor: user,
      action: "TARIFF_ARCHIVE",
      entity: "Tariff",
      entityId: id,
      after: { effectiveTo: archived.effectiveTo, reason },
      ...ctx,
    });

    return { archived: true, id, effectiveTo: archived.effectiveTo };
  }

  /** Quote preview — the officer's sandbox. Identical maths to a live session. */
  async preview(dto: PreviewQuoteDto) {
    const startAt = dto.startAt ?? new Date();
    const endAt =
      dto.endAt ?? new Date(startAt.getTime() + (dto.durationMinutes ?? 60) * 60_000);

    return this.quotes.quote({
      zoneId: dto.zoneId,
      vehicleType: dto.vehicleType,
      startAt,
      endAt,
      discountCode: dto.discountCode,
      vehicleId: dto.vehicleId,
      overstayAfterMinutes: dto.overstayAfterMinutes,
    });
  }

  /** What an attendant or citizen is shown before a session starts. */
  async applicable(zoneId: string, vehicleType: PreviewQuoteDto["vehicleType"], at?: Date) {
    const tariff = await this.quotes.resolveTariff(zoneId, vehicleType, at ?? new Date());
    return {
      id: tariff.id,
      name: tariff.name,
      zoneId: tariff.zoneId,
      vehicleType,
      baseAmount: tariff.baseAmount,
      baseMinutes: tariff.baseMinutes,
      incrementAmount: tariff.incrementAmount,
      incrementMinutes: tariff.incrementMinutes,
      dailyCapAmount: tariff.dailyCapAmount,
      gracePeriodMin: tariff.gracePeriodMin,
      overstayPenalty: tariff.overstayPenalty,
      taxPercent: Number(tariff.taxPercent),
      scope: tariff.zoneId ? "ZONE" : "CITY_WIDE",
      /**
       * The rules matter as much as the base rate.
       *
       * A handset caching this to quote a provisional fare without them would
       * silently drop every peak, night, weekend and holiday surcharge and
       * quote *under* the real price — and an under-quote means chasing a
       * driver who has already gone.
       */
      rules: tariff.rules.map((rule) => ({
        type: rule.type,
        label: ruleLabel(rule.type, rule.multiplier === null ? null : Number(rule.multiplier), rule.flatAmount),
        dayType: rule.dayType,
        timeFrom: rule.timeFrom,
        timeTo: rule.timeTo,
        multiplier: rule.multiplier === null ? null : Number(rule.multiplier),
        flatAmount: rule.flatAmount,
        priority: rule.priority,
        isActive: rule.isActive,
      })),
    };
  }

  // ------------------------------------------------------------- holidays

  listHolidays() {
    return this.prisma.holiday.findMany({ orderBy: { date: "asc" } });
  }

  async createHoliday(dto: CreateHolidayDto, user: AuthenticatedUser, ctx: { ip?: string; requestId?: string }) {
    const holiday = await this.prisma.holiday.create({
      data: {
        date: dto.date,
        name: dto.name,
        isEvent: dto.isEvent,
        zoneIds: dto.zoneIds,
        multiplier: dto.multiplier !== undefined ? new Prisma.Decimal(dto.multiplier) : null,
      },
    });
    await this.audit.record({
      actor: user,
      action: "HOLIDAY_CREATE",
      entity: "Holiday",
      entityId: holiday.id,
      after: holiday,
      ...ctx,
    });
    return holiday;
  }

  async removeHoliday(id: string, user: AuthenticatedUser, ctx: { ip?: string; requestId?: string }) {
    await this.prisma.holiday.delete({ where: { id } });
    await this.audit.record({
      actor: user,
      action: "HOLIDAY_DELETE",
      entity: "Holiday",
      entityId: id,
      ...ctx,
    });
    return { deleted: true };
  }

  // ------------------------------------------------------------ discounts

  listDiscounts() {
    return this.prisma.discount.findMany({ orderBy: { validTo: "desc" } });
  }

  async createDiscount(dto: CreateDiscountDto, user: AuthenticatedUser, ctx: { ip?: string; requestId?: string }) {
    const discount = await this.prisma.discount.create({
      data: {
        name: dto.name,
        code: dto.code,
        zoneId: dto.zoneId,
        vehicleTypeId: dto.vehicleTypeId,
        percentOff: dto.percentOff !== undefined ? new Prisma.Decimal(dto.percentOff) : null,
        flatOff: dto.flatOff,
        validFrom: dto.validFrom,
        validTo: dto.validTo,
        maxUses: dto.maxUses,
        isActive: dto.isActive,
      },
    });
    await this.audit.record({
      actor: user,
      action: "DISCOUNT_CREATE",
      entity: "Discount",
      entityId: discount.id,
      after: discount,
      ...ctx,
    });
    return discount;
  }

  async toggleDiscount(id: string, isActive: boolean, user: AuthenticatedUser, ctx: { ip?: string; requestId?: string }) {
    const discount = await this.prisma.discount.update({ where: { id }, data: { isActive } });
    await this.audit.record({
      actor: user,
      action: isActive ? "DISCOUNT_RESUME" : "DISCOUNT_PAUSE",
      entity: "Discount",
      entityId: id,
      after: { isActive },
      ...ctx,
    });
    return discount;
  }
}
