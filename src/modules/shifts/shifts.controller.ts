import { Body, Controller, Get, Param, Post, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";

import { zodPipe } from "@/common/pipes/zod-validation.pipe";
import {
  ClientInfo,
  CurrentUser,
  RequestId,
  RequirePermissions,
  type AuthenticatedUser,
} from "@/common/decorators/auth.decorators";
import { ShiftsService } from "./shifts.service";
import {
  CloseShiftSchema,
  OpenShiftSchema,
  ShiftQuerySchema,
  VerifyShiftSchema,
  type CloseShiftDto,
  type OpenShiftDto,
  type ShiftQueryDto,
  type VerifyShiftDto,
} from "./dto/shift.dto";

/**
 * Shifts: the unit of accountability for cash.
 *
 * The attendant opens one, collects against it, and closes it by declaring what
 * they are handing in. Somebody else confirms receipt. Those are three separate
 * acts by design — one person doing all of them is how cash goes missing.
 */
@ApiTags("Shifts")
@ApiBearerAuth("bearer")
@Controller("shifts")
export class ShiftsController {
  constructor(private readonly shifts: ShiftsService) {}

  @RequirePermissions("session.read")
  @Get("current")
  @ApiOperation({
    summary: "The signed-in attendant's open shift, or null",
    description: "What the vendor app asks for on launch. Cash figures are live, not stored counters.",
  })
  current(@CurrentUser() user: AuthenticatedUser) {
    return this.shifts.current(user);
  }

  @RequirePermissions("session.read")
  @Get()
  @ApiOperation({ summary: "Shifts, filtered by attendant, vendor, zone, status or variance" })
  list(@Query(zodPipe(ShiftQuerySchema)) query: ShiftQueryDto, @CurrentUser() user: AuthenticatedUser) {
    return this.shifts.list(query, user);
  }

  @RequirePermissions("session.read")
  @Get(":id")
  @ApiOperation({ summary: "One shift with its recomputed collection totals" })
  findOne(@Param("id") id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.shifts.findOne(id, user);
  }

  @RequirePermissions("session.read")
  @Post("open")
  @ApiOperation({
    summary: "Start a shift",
    description: "Returns the existing shift if one is already open, so a retry is harmless.",
  })
  open(
    @Body(zodPipe(OpenShiftSchema)) dto: OpenShiftDto,
    @CurrentUser() user: AuthenticatedUser,
    @ClientInfo() info: { ip?: string },
    @RequestId() requestId: string,
  ) {
    return this.shifts.open(dto, user, { ...info, requestId });
  }

  @RequirePermissions("session.read")
  @Post(":id/close")
  @ApiOperation({
    summary: "Close a shift against a declared cash figure",
    description:
      "Refused while any session is still running — their fares belong to this shift. The declared " +
      "amount is compared against what the payments say was collected, and any gap is recorded.",
  })
  close(
    @Param("id") id: string,
    @Body(zodPipe(CloseShiftSchema)) dto: CloseShiftDto,
    @CurrentUser() user: AuthenticatedUser,
    @ClientInfo() info: { ip?: string },
    @RequestId() requestId: string,
  ) {
    return this.shifts.close(id, dto, user, { ...info, requestId });
  }

  @RequirePermissions("shift.verify")
  @Post(":id/verify")
  @ApiOperation({
    summary: "Confirm the cash was received",
    description: "Nobody may verify their own shift.",
  })
  verify(
    @Param("id") id: string,
    @Body(zodPipe(VerifyShiftSchema)) dto: VerifyShiftDto,
    @CurrentUser() user: AuthenticatedUser,
    @ClientInfo() info: { ip?: string },
    @RequestId() requestId: string,
  ) {
    return this.shifts.verify(id, dto, user, { ...info, requestId });
  }
}
