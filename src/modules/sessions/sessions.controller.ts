import { Body, Controller, Get, Param, Post, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";

import { zodPipe } from "@/common/pipes/zod-validation.pipe";
import {
  ClientInfo,
  CurrentUser,
  IdempotencyKey,
  RequestId,
  RequirePermissions,
  type AuthenticatedUser,
} from "@/common/decorators/auth.decorators";
import { SessionsService } from "./sessions.service";
import {
  CancelSessionSchema,
  EndSessionSchema,
  SessionQuerySchema,
  StartSessionSchema,
  type CancelSessionDto,
  type EndSessionDto,
  type SessionQueryDto,
  type StartSessionDto,
} from "./dto/session.dto";

/**
 * Parking sessions.
 *
 * Start and end are safe to replay: send the same `clientEventId` and you get
 * the same session and the same fare back. The vendor app queues events while
 * it is offline and flushes them later, sometimes more than once, and a
 * duplicate must never become a second charge.
 *
 * Callers with no device event id — the portal, the citizen app — get the same
 * protection from an `Idempotency-Key` header.
 */
@ApiTags("Sessions")
@ApiBearerAuth("bearer")
@Controller("sessions")
export class SessionsController {
  constructor(private readonly sessions: SessionsService) {}

  @RequirePermissions("session.read")
  @Get()
  @ApiOperation({ summary: "Search sessions by plate, zone, vendor, status or date" })
  list(
    @Query(zodPipe(SessionQuerySchema)) query: SessionQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.sessions.list(query, user);
  }

  @RequirePermissions("session.read")
  @Get("live")
  @ApiOperation({ summary: "Live occupancy and overstay counts" })
  live(@CurrentUser() user: AuthenticatedUser) {
    return this.sessions.live(user);
  }

  @RequirePermissions("session.read")
  @Get("plate/:plateNumber")
  @ApiOperation({
    summary: "What this vehicle is doing now, and its recent history",
    description: "The attendant's first action at the kerb — start a session, or end the live one.",
  })
  lookup(@Param("plateNumber") plateNumber: string, @CurrentUser() user: AuthenticatedUser) {
    return this.sessions.lookupPlate(plateNumber, user);
  }

  @RequirePermissions("session.read")
  @Get(":id")
  @ApiOperation({ summary: "One session by id or by its quotable code" })
  findOne(@Param("id") id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.sessions.findOne(id, user);
  }

  // Attendants hold session.read, not a write permission — starting a session
  // is their job, and the guard rails are the zone, geo-fence and duplicate
  // checks inside the service rather than a separate grant.
  @RequirePermissions("session.read")
  @Post("start")
  @ApiOperation({
    summary: "Start a parking session",
    description:
      "Validates the zone is open, the vehicle type is permitted, there is space, the plate is not " +
      "already parked, and the device is inside the geo-fence. Replaying a clientEventId returns the " +
      "original session.",
  })
  start(
    @Body(zodPipe(StartSessionSchema)) dto: StartSessionDto,
    @CurrentUser() user: AuthenticatedUser,
    @ClientInfo() info: { ip?: string },
    @RequestId() requestId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
  ) {
    return this.sessions.start(dto, user, { ...info, requestId, idempotencyKey });
  }

  @RequirePermissions("session.read")
  @Post(":id/end")
  @ApiOperation({
    summary: "End a session and price it",
    description:
      "The fare is computed from the tariff live for that zone and stored with its full breakdown, " +
      "so a receipt issued later shows the same lines.",
  })
  end(
    @Param("id") id: string,
    @Body(zodPipe(EndSessionSchema)) dto: EndSessionDto,
    @CurrentUser() user: AuthenticatedUser,
    @ClientInfo() info: { ip?: string },
    @RequestId() requestId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
  ) {
    return this.sessions.end(id, dto, user, { ...info, requestId, idempotencyKey });
  }

  @RequirePermissions("session.cancel")
  @Post(":id/cancel")
  @ApiOperation({
    summary: "Cancel a session",
    description: "For a session started in error. A completed session is refunded, never cancelled.",
  })
  cancel(
    @Param("id") id: string,
    @Body(zodPipe(CancelSessionSchema)) dto: CancelSessionDto,
    @CurrentUser() user: AuthenticatedUser,
    @ClientInfo() info: { ip?: string },
    @RequestId() requestId: string,
  ) {
    return this.sessions.cancel(id, dto, user, { ...info, requestId });
  }
}
