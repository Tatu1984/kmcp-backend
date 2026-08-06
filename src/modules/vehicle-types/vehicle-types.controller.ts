import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Prisma, SlotType } from "@prisma/client";
import { z } from "zod";

import { PrismaService } from "@/prisma/prisma.service";
import { zodPipe } from "@/common/pipes/zod-validation.pipe";
import {
  ClientInfo,
  CurrentUser,
  Public,
  RequestId,
  RequirePermissions,
  type AuthenticatedUser,
} from "@/common/decorators/auth.decorators";
import { AppException } from "@/common/errors/app.exception";
import { AuditService } from "@/common/services/audit.service";

const CreateVehicleTypeSchema = z.object({
  code: z.nativeEnum(SlotType),
  label: z.string().trim().min(2).max(60),
  iconKey: z.string().trim().max(60).optional(),
  sortOrder: z.number().int().min(0).max(999).default(0),
  isActive: z.boolean().default(true),
});
type CreateVehicleTypeDto = z.infer<typeof CreateVehicleTypeSchema>;

const UpdateVehicleTypeSchema = CreateVehicleTypeSchema.partial().omit({ code: true });
type UpdateVehicleTypeDto = z.infer<typeof UpdateVehicleTypeSchema>;

const VehicleTypeQuerySchema = z.object({
  includeInactive: z.coerce.boolean().optional(),
});
type VehicleTypeQueryDto = z.infer<typeof VehicleTypeQuerySchema>;

/**
 * The vehicle categories the whole platform prices against. Reference data:
 * short list, rarely edited, read by every client on startup.
 *
 * `code` is fixed to the SlotType enum because zones, tariffs and slots all key
 * off it — a free-text category would let someone create a class of vehicle no
 * tariff can price.
 */
@ApiTags("Vehicle types")
@ApiBearerAuth("bearer")
@Controller("vehicle-types")
export class VehicleTypesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  @Public()
  @Get()
  @ApiOperation({
    summary: "Vehicle categories in display order",
    description: "Public — the citizen app needs it to register a vehicle before anyone signs in.",
  })
  async list(@Query(zodPipe(VehicleTypeQuerySchema)) query: VehicleTypeQueryDto) {
    const where: Prisma.VehicleTypeWhereInput = query.includeInactive ? {} : { isActive: true };
    return this.prisma.vehicleType.findMany({
      where,
      orderBy: [{ sortOrder: "asc" }, { label: "asc" }],
    });
  }

  @RequirePermissions("config.write")
  @Post()
  @ApiOperation({ summary: "Add a vehicle category" })
  async create(
    @Body(zodPipe(CreateVehicleTypeSchema)) dto: CreateVehicleTypeDto,
    @CurrentUser() user: AuthenticatedUser,
    @ClientInfo() info: { ip?: string },
    @RequestId() requestId: string,
  ) {
    const clash = await this.prisma.vehicleType.findUnique({ where: { code: dto.code } });
    if (clash) throw new AppException("DUPLICATE_RESOURCE", [{ field: "code", issue: "already defined" }]);

    const created = await this.prisma.vehicleType.create({ data: dto });

    await this.audit.record({
      actor: user,
      action: "VEHICLE_TYPE_CREATE",
      entity: "VehicleType",
      entityId: created.id,
      after: created,
      ip: info.ip,
      requestId,
    });

    return created;
  }

  @RequirePermissions("config.write")
  @Patch(":id")
  @ApiOperation({ summary: "Relabel, reorder or deactivate a category" })
  async update(
    @Param("id") id: string,
    @Body(zodPipe(UpdateVehicleTypeSchema)) dto: UpdateVehicleTypeDto,
    @CurrentUser() user: AuthenticatedUser,
    @ClientInfo() info: { ip?: string },
    @RequestId() requestId: string,
  ) {
    const before = await this.prisma.vehicleType.findUnique({ where: { id } });
    if (!before) throw AppException.notFound("vehicle type");

    const after = await this.prisma.vehicleType.update({ where: { id }, data: dto });

    await this.audit.record({
      actor: user,
      action: "VEHICLE_TYPE_UPDATE",
      entity: "VehicleType",
      entityId: id,
      before,
      after,
      ip: info.ip,
      requestId,
    });

    return after;
  }

  @RequirePermissions("config.write")
  @Delete(":id")
  @ApiOperation({
    summary: "Withdraw a category from use",
    description:
      "Deactivates rather than deletes once anything references it — priced history has to stay readable.",
  })
  async remove(
    @Param("id") id: string,
    @CurrentUser() user: AuthenticatedUser,
    @ClientInfo() info: { ip?: string },
    @RequestId() requestId: string,
  ) {
    const type = await this.prisma.vehicleType.findUnique({
      where: { id },
      include: { _count: { select: { vehicles: true, tariffs: true, sessions: true } } },
    });
    if (!type) throw AppException.notFound("vehicle type");

    const referenced =
      type._count.vehicles > 0 || type._count.tariffs > 0 || type._count.sessions > 0;

    if (referenced) {
      const deactivated = await this.prisma.vehicleType.update({
        where: { id },
        data: { isActive: false },
      });
      await this.audit.record({
        actor: user,
        action: "VEHICLE_TYPE_DEACTIVATE",
        entity: "VehicleType",
        entityId: id,
        before: { isActive: type.isActive },
        after: { isActive: false, reason: "still referenced" },
        ip: info.ip,
        requestId,
      });
      return { deactivated: true, deleted: false, ...deactivated };
    }

    await this.prisma.vehicleType.delete({ where: { id } });
    await this.audit.record({
      actor: user,
      action: "VEHICLE_TYPE_DELETE",
      entity: "VehicleType",
      entityId: id,
      before: { code: type.code, label: type.label },
      ip: info.ip,
      requestId,
    });

    return { deactivated: false, deleted: true, id };
  }
}
