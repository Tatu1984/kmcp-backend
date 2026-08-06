import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";

import { PrismaService } from "@/prisma/prisma.service";
import { AppException } from "@/common/errors/app.exception";
import { AuditService } from "@/common/services/audit.service";
import { Paginated } from "@/common/interceptors/response.interceptor";
import { orderBy, skipTake } from "@/common/dto/pagination.dto";
import type { AuthenticatedUser } from "@/common/decorators/auth.decorators";
import type {
  CreateStreetDto,
  CreateWardDto,
  StreetQueryDto,
  UpdateStreetDto,
  UpdateWardDto,
  WardQueryDto,
} from "./dto/geography.dto";

type Ctx = { ip?: string; requestId?: string };

const WARD_SORTABLE = ["code", "name"] as const;
const STREET_SORTABLE = ["name"] as const;

/**
 * Wards and the streets inside them — the administrative skeleton every zone
 * hangs off. Small, slow-changing reference data, but it is what makes a
 * revenue report say "Ward 63" instead of a list of coordinates.
 */
@Injectable()
export class GeographyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async listWards(query: WardQueryDto) {
    const where: Prisma.WardWhereInput = query.q
      ? {
          OR: [
            { code: { contains: query.q, mode: "insensitive" } },
            { name: { contains: query.q, mode: "insensitive" } },
          ],
        }
      : {};

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.ward.findMany({
        where,
        include: { _count: { select: { streets: true, zones: true } } },
        orderBy: orderBy(query.sort, WARD_SORTABLE, { code: "asc" }),
        ...skipTake(query),
      }),
      this.prisma.ward.count({ where }),
    ]);

    return new Paginated(
      rows.map(({ _count, ...ward }) => ({
        ...ward,
        streetCount: _count.streets,
        zoneCount: _count.zones,
      })),
      query.page,
      query.pageSize,
      total,
    );
  }

  async findWard(id: string) {
    const ward = await this.prisma.ward.findUnique({
      where: { id },
      include: {
        streets: { orderBy: { name: "asc" }, select: { id: true, name: true } },
        _count: { select: { zones: true } },
      },
    });
    if (!ward) throw AppException.notFound("ward");

    const { _count, ...rest } = ward;
    return { ...rest, zoneCount: _count.zones };
  }

  async createWard(dto: CreateWardDto, user: AuthenticatedUser, ctx: Ctx) {
    const clash = await this.prisma.ward.findUnique({ where: { code: dto.code } });
    if (clash) throw new AppException("DUPLICATE_RESOURCE", [{ field: "code", issue: "already in use" }]);

    const ward = await this.prisma.ward.create({ data: dto });

    await this.audit.record({
      actor: user,
      action: "WARD_CREATE",
      entity: "Ward",
      entityId: ward.id,
      after: { code: ward.code, name: ward.name },
      ...ctx,
    });

    return ward;
  }

  async updateWard(id: string, dto: UpdateWardDto, user: AuthenticatedUser, ctx: Ctx) {
    const before = await this.prisma.ward.findUnique({ where: { id } });
    if (!before) throw AppException.notFound("ward");

    if (dto.code && dto.code !== before.code) {
      const clash = await this.prisma.ward.findUnique({ where: { code: dto.code } });
      if (clash) throw new AppException("DUPLICATE_RESOURCE", [{ field: "code", issue: "already in use" }]);
    }

    const after = await this.prisma.ward.update({ where: { id }, data: dto });

    await this.audit.record({
      actor: user,
      action: "WARD_UPDATE",
      entity: "Ward",
      entityId: id,
      before,
      after,
      ...ctx,
    });

    return after;
  }

  /**
   * Refused while anything still points at it. A ward is a label on historical
   * revenue — deleting one would orphan reports that have already been signed off.
   */
  async removeWard(id: string, user: AuthenticatedUser, ctx: Ctx) {
    const ward = await this.prisma.ward.findUnique({
      where: { id },
      include: { _count: { select: { streets: true, zones: true } } },
    });
    if (!ward) throw AppException.notFound("ward");

    if (ward._count.zones > 0 || ward._count.streets > 0) {
      throw new AppException(
        "FORBIDDEN",
        [
          { field: "id", issue: `${ward._count.zones} zone(s) and ${ward._count.streets} street(s) still reference this ward` },
        ],
        "Move or retire everything in this ward before removing it.",
      );
    }

    await this.prisma.ward.delete({ where: { id } });

    await this.audit.record({
      actor: user,
      action: "WARD_DELETE",
      entity: "Ward",
      entityId: id,
      before: { code: ward.code, name: ward.name },
      ...ctx,
    });

    return { deleted: true, id };
  }

  async listStreets(query: StreetQueryDto) {
    const where: Prisma.StreetWhereInput = {
      ...(query.wardId ? { wardId: query.wardId } : {}),
      ...(query.q ? { name: { contains: query.q, mode: "insensitive" } } : {}),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.street.findMany({
        where,
        include: {
          ward: { select: { id: true, code: true, name: true } },
          _count: { select: { zones: true } },
        },
        orderBy: orderBy(query.sort, STREET_SORTABLE, { name: "asc" }),
        ...skipTake(query),
      }),
      this.prisma.street.count({ where }),
    ]);

    return new Paginated(
      rows.map(({ _count, ...street }) => ({ ...street, zoneCount: _count.zones })),
      query.page,
      query.pageSize,
      total,
    );
  }

  async createStreet(dto: CreateStreetDto, user: AuthenticatedUser, ctx: Ctx) {
    const ward = await this.prisma.ward.findUnique({ where: { id: dto.wardId } });
    if (!ward) throw AppException.notFound("ward");

    const street = await this.prisma.street.create({
      data: dto,
      include: { ward: { select: { id: true, code: true, name: true } } },
    });

    await this.audit.record({
      actor: user,
      action: "STREET_CREATE",
      entity: "Street",
      entityId: street.id,
      after: { name: street.name, wardId: street.wardId },
      ...ctx,
    });

    return street;
  }

  async updateStreet(id: string, dto: UpdateStreetDto, user: AuthenticatedUser, ctx: Ctx) {
    const before = await this.prisma.street.findUnique({ where: { id } });
    if (!before) throw AppException.notFound("street");

    if (dto.wardId && dto.wardId !== before.wardId) {
      const ward = await this.prisma.ward.findUnique({ where: { id: dto.wardId } });
      if (!ward) throw AppException.notFound("ward");
    }

    const after = await this.prisma.street.update({
      where: { id },
      data: dto,
      include: { ward: { select: { id: true, code: true, name: true } } },
    });

    await this.audit.record({
      actor: user,
      action: "STREET_UPDATE",
      entity: "Street",
      entityId: id,
      before,
      after: { name: after.name, wardId: after.wardId },
      ...ctx,
    });

    return after;
  }

  async removeStreet(id: string, user: AuthenticatedUser, ctx: Ctx) {
    const street = await this.prisma.street.findUnique({
      where: { id },
      include: { _count: { select: { zones: true } } },
    });
    if (!street) throw AppException.notFound("street");

    if (street._count.zones > 0) {
      throw new AppException(
        "FORBIDDEN",
        [{ field: "id", issue: `${street._count.zones} zone(s) still reference this street` }],
        "Reassign the zones on this street before removing it.",
      );
    }

    await this.prisma.street.delete({ where: { id } });

    await this.audit.record({
      actor: user,
      action: "STREET_DELETE",
      entity: "Street",
      entityId: id,
      before: { name: street.name, wardId: street.wardId },
      ...ctx,
    });

    return { deleted: true, id };
  }
}
