import { Body, Controller, Get, Param, Patch, Post, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";

import { zodPipe } from "@/common/pipes/zod-validation.pipe";
import {
  ClientInfo,
  CurrentUser,
  RequestId,
  RequirePermissions,
  type AuthenticatedUser,
} from "@/common/decorators/auth.decorators";
import { AttendantsService } from "./attendants.service";
import {
  AttendantQuerySchema,
  AttendantStatusSchema,
  CreateAttendantSchema,
  TransferAttendantSchema,
  UpdateAttendantSchema,
  type AttendantQueryDto,
  type AttendantStatusDto,
  type CreateAttendantDto,
  type TransferAttendantDto,
  type UpdateAttendantDto,
  UnbindDeviceSchema,
  type UnbindDeviceDto,
} from "./dto/attendant.dto";

@ApiTags("Attendants")
@ApiBearerAuth("bearer")
@Controller("attendants")
export class AttendantsController {
  constructor(private readonly attendants: AttendantsService) {}

  @RequirePermissions("vendor.read")
  @Get()
  @ApiOperation({
    summary: "Attendants with their live shift state",
    description: "A vendor signing in sees only their own staff.",
  })
  list(
    @Query(zodPipe(AttendantQuerySchema)) query: AttendantQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.attendants.list(query, user);
  }

  @RequirePermissions("vendor.read")
  @Get(":id")
  @ApiOperation({ summary: "One attendant with devices, shift and totals" })
  findOne(@Param("id") id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.attendants.findOne(id, user);
  }

  @RequirePermissions("attendant.write")
  @Post()
  @ApiOperation({
    summary: "Enrol an attendant",
    description: "Creates the field login and the employment record together. The vendor must be approved.",
  })
  create(
    @Body(zodPipe(CreateAttendantSchema)) dto: CreateAttendantDto,
    @CurrentUser() user: AuthenticatedUser,
    @ClientInfo() info: { ip?: string },
    @RequestId() requestId: string,
  ) {
    return this.attendants.create(dto, user, { ...info, requestId });
  }

  @RequirePermissions("attendant.write")
  @Patch(":id")
  @ApiOperation({ summary: "Update an attendant's details or default zone" })
  update(
    @Param("id") id: string,
    @Body(zodPipe(UpdateAttendantSchema)) dto: UpdateAttendantDto,
    @CurrentUser() user: AuthenticatedUser,
    @ClientInfo() info: { ip?: string },
    @RequestId() requestId: string,
  ) {
    return this.attendants.update(id, dto, user, { ...info, requestId });
  }

  @RequirePermissions("attendant.write")
  @Post(":id/status")
  @ApiOperation({
    summary: "Activate or deactivate an attendant",
    description:
      "Deactivating signs them out everywhere and unbinds their devices. Refused while a shift is open.",
  })
  setActive(
    @Param("id") id: string,
    @Body(zodPipe(AttendantStatusSchema)) dto: AttendantStatusDto,
    @CurrentUser() user: AuthenticatedUser,
    @ClientInfo() info: { ip?: string },
    @RequestId() requestId: string,
  ) {
    return this.attendants.setActive(id, dto, user, { ...info, requestId });
  }

  @RequirePermissions("attendant.write")
  @Post(":id/unbind-device")
  @ApiOperation({
    summary: "Release every device bound to an attendant",
    description: "Their sessions end with it. Use when a handset is lost or replaced.",
  })
  unbindDevices(
    @Param("id") id: string,
    @Body(zodPipe(UnbindDeviceSchema)) dto: UnbindDeviceDto,
    @CurrentUser() user: AuthenticatedUser,
    @ClientInfo() info: { ip?: string },
    @RequestId() requestId: string,
  ) {
    return this.attendants.unbindDevices(id, dto.reason, user, { ...info, requestId });
  }

  @RequirePermissions("vendor.write")
  @Post(":id/transfer")
  @ApiOperation({
    summary: "Move an attendant to another vendor",
    description: "Refused while a shift is open — that cash belongs to the current vendor.",
  })
  transfer(
    @Param("id") id: string,
    @Body(zodPipe(TransferAttendantSchema)) dto: TransferAttendantDto,
    @CurrentUser() user: AuthenticatedUser,
    @ClientInfo() info: { ip?: string },
    @RequestId() requestId: string,
  ) {
    return this.attendants.transfer(id, dto, user, { ...info, requestId });
  }
}
