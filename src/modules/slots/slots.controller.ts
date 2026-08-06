import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";

import { zodPipe } from "@/common/pipes/zod-validation.pipe";
import {
  ClientInfo,
  CurrentUser,
  RequestId,
  RequirePermissions,
  type AuthenticatedUser,
} from "@/common/decorators/auth.decorators";
import { SlotsService } from "./slots.service";
import {
  BulkCreateSlotsSchema,
  CreateSlotSchema,
  SlotQuerySchema,
  SlotStatusSchema,
  UpdateSlotSchema,
  type BulkCreateSlotsDto,
  type CreateSlotDto,
  type SlotQueryDto,
  type SlotStatusDto,
  type UpdateSlotDto,
} from "./dto/slot.dto";

@ApiTags("Slots")
@ApiBearerAuth("bearer")
@Controller("slots")
export class SlotsController {
  constructor(private readonly slots: SlotsService) {}

  @RequirePermissions("zone.read")
  @Get()
  @ApiOperation({ summary: "Bays, filtered by zone, type or status" })
  list(@Query(zodPipe(SlotQuerySchema)) query: SlotQueryDto, @CurrentUser() user: AuthenticatedUser) {
    return this.slots.list(query, user);
  }

  @RequirePermissions("zone.read")
  @Get("summary/:zoneId")
  @ApiOperation({
    summary: "Bay counts for one zone",
    description: "Includes bays mapped against priced capacity — the two are not the same number.",
  })
  summary(@Param("zoneId") zoneId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.slots.summary(zoneId, user);
  }

  @RequirePermissions("slot.write")
  @Post()
  @ApiOperation({ summary: "Add a single bay" })
  create(
    @Body(zodPipe(CreateSlotSchema)) dto: CreateSlotDto,
    @CurrentUser() user: AuthenticatedUser,
    @ClientInfo() info: { ip?: string },
    @RequestId() requestId: string,
  ) {
    return this.slots.create(dto, user, { ...info, requestId });
  }

  @RequirePermissions("slot.write")
  @Post("bulk")
  @ApiOperation({
    summary: "Number a run of bays",
    description: "Generates PREFIX001…PREFIX0NN. Existing codes are skipped, so it is safe to repeat.",
  })
  bulkCreate(
    @Body(zodPipe(BulkCreateSlotsSchema)) dto: BulkCreateSlotsDto,
    @CurrentUser() user: AuthenticatedUser,
    @ClientInfo() info: { ip?: string },
    @RequestId() requestId: string,
  ) {
    return this.slots.bulkCreate(dto, user, { ...info, requestId });
  }

  @RequirePermissions("slot.write")
  @Patch(":id")
  @ApiOperation({ summary: "Change a bay's category or reservation" })
  update(
    @Param("id") id: string,
    @Body(zodPipe(UpdateSlotSchema)) dto: UpdateSlotDto,
    @CurrentUser() user: AuthenticatedUser,
    @ClientInfo() info: { ip?: string },
    @RequestId() requestId: string,
  ) {
    return this.slots.update(id, dto, user, { ...info, requestId });
  }

  @RequirePermissions("slot.write")
  @Post(":id/status")
  @ApiOperation({
    summary: "Put a bay in or out of service",
    description: "Refused while a vehicle is parked in it.",
  })
  changeStatus(
    @Param("id") id: string,
    @Body(zodPipe(SlotStatusSchema)) dto: SlotStatusDto,
    @CurrentUser() user: AuthenticatedUser,
    @ClientInfo() info: { ip?: string },
    @RequestId() requestId: string,
  ) {
    return this.slots.changeStatus(id, dto, user, { ...info, requestId });
  }

  @RequirePermissions("slot.write")
  @Delete(":id")
  @ApiOperation({
    summary: "Remove a bay",
    description: "Retired instead of deleted once it has session history.",
  })
  remove(
    @Param("id") id: string,
    @CurrentUser() user: AuthenticatedUser,
    @ClientInfo() info: { ip?: string },
    @RequestId() requestId: string,
  ) {
    return this.slots.remove(id, user, { ...info, requestId });
  }
}
