import { Body, Controller, Delete, Get, Param, Post, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";

import { zodPipe } from "@/common/pipes/zod-validation.pipe";
import {
  ClientInfo,
  CurrentUser,
  RequestId,
  type AuthenticatedUser,
} from "@/common/decorators/auth.decorators";
import { MeService } from "./me.service";
import {
  AddFavouriteSchema,
  AddVehicleSchema,
  MyPaymentsQuerySchema,
  MySessionsQuerySchema,
  MySummaryQuerySchema,
  type AddFavouriteDto,
  type AddVehicleDto,
  type MyPaymentsQueryDto,
  type MySessionsQueryDto,
  type MySummaryQueryDto,
} from "./dto/me.dto";

/**
 * The citizen's own things — vehicles, sessions, spend and favourites.
 *
 * No `@RequirePermissions` anywhere in this file, deliberately. A citizen
 * managing their own vehicles or looking at their own history needs nothing
 * beyond a valid token, the same reasoning `AuthController.me` already relies
 * on for `GET /auth/me`. `RbacGuard` falls through to `true` when a handler
 * carries no role or permission metadata, so the global `JwtAuthGuard` — which
 * still runs — is the entire gate here. `MeService` scopes every query to
 * `user.id` itself, so there is no row this can expose that does not already
 * belong to the caller.
 */
@ApiTags("Me")
@ApiBearerAuth("bearer")
@Controller("me")
export class MeController {
  constructor(private readonly me: MeService) {}

  @Get("vehicles")
  @ApiOperation({ summary: "Vehicles this citizen has registered or claimed" })
  listVehicles(@CurrentUser() user: AuthenticatedUser) {
    return this.me.listVehicles(user);
  }

  @Post("vehicles")
  @ApiOperation({
    summary: "Register a vehicle by plate",
    description:
      "Creates the vehicle on first sight, or claims it if an attendant already started a " +
      "session against the plate before this citizen ever opened the app.",
  })
  addVehicle(
    @Body(zodPipe(AddVehicleSchema)) dto: AddVehicleDto,
    @CurrentUser() user: AuthenticatedUser,
    @ClientInfo() info: { ip?: string },
    @RequestId() requestId: string,
  ) {
    return this.me.addVehicle(dto, user, { ...info, requestId });
  }

  @Delete("vehicles/:vehicleId")
  @ApiOperation({
    summary: "Remove a vehicle from this citizen's garage",
    description:
      "Releases the citizen's claim on the plate rather than deleting it — its parking and " +
      "payment history stay exactly as they were.",
  })
  removeVehicle(
    @Param("vehicleId") vehicleId: string,
    @CurrentUser() user: AuthenticatedUser,
    @ClientInfo() info: { ip?: string },
    @RequestId() requestId: string,
  ) {
    return this.me.removeVehicle(vehicleId, user, { ...info, requestId });
  }

  @Get("sessions")
  @ApiOperation({ summary: "This citizen's own parking sessions" })
  listSessions(
    @Query(zodPipe(MySessionsQuerySchema)) query: MySessionsQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.me.listSessions(query, user);
  }

  @Get("summary")
  @ApiOperation({ summary: "Spend and session totals for one calendar month" })
  summary(
    @Query(zodPipe(MySummaryQuerySchema)) query: MySummaryQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.me.summary(query.month, user);
  }

  @Get("payments")
  @ApiOperation({ summary: "Payments this citizen made, newest first" })
  listPayments(
    @Query(zodPipe(MyPaymentsQuerySchema)) query: MyPaymentsQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.me.listPayments(query, user);
  }

  @Get("favourites")
  @ApiOperation({ summary: "This citizen's saved car parks" })
  listFavourites(@CurrentUser() user: AuthenticatedUser) {
    return this.me.listFavourites(user);
  }

  @Post("favourites")
  @ApiOperation({ summary: "Save a car park" })
  addFavourite(
    @Body(zodPipe(AddFavouriteSchema)) dto: AddFavouriteDto,
    @CurrentUser() user: AuthenticatedUser,
    @ClientInfo() info: { ip?: string },
    @RequestId() requestId: string,
  ) {
    return this.me.addFavourite(dto, user, { ...info, requestId });
  }

  @Delete("favourites/:zoneId")
  @ApiOperation({ summary: "Unsave a car park" })
  removeFavourite(
    @Param("zoneId") zoneId: string,
    @CurrentUser() user: AuthenticatedUser,
    @ClientInfo() info: { ip?: string },
    @RequestId() requestId: string,
  ) {
    return this.me.removeFavourite(zoneId, user, { ...info, requestId });
  }
}
