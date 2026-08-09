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
import { CitizensService } from "./citizens.service";
import {
  CitizenQuerySchema,
  CitizenStatusSchema,
  VehicleBlacklistSchema,
  type CitizenQueryDto,
  type CitizenStatusDto,
  type VehicleBlacklistDto,
} from "./dto/citizen.dto";

@ApiTags("Citizens")
@ApiBearerAuth("bearer")
@Controller("citizens")
export class CitizensController {
  constructor(private readonly citizens: CitizensService) {}

  @RequirePermissions("session.read")
  @Get()
  @ApiOperation({
    summary: "Registered citizens, with vehicles, sessions and lifetime spend",
    description: "History is reached through the vehicles they have claimed, not through the session.",
  })
  list(@Query(zodPipe(CitizenQuerySchema)) query: CitizenQueryDto) {
    return this.citizens.list(query);
  }

  @RequirePermissions("session.read")
  @Get("summary")
  @ApiOperation({ summary: "Counts by status, pass holders and claimed vehicles" })
  summary() {
    return this.citizens.summary();
  }

  @RequirePermissions("session.read")
  @Get(":id")
  @ApiOperation({ summary: "One citizen with their vehicles, recent sessions and passes" })
  findOne(@Param("id") id: string) {
    return this.citizens.findOne(id);
  }

  @RequirePermissions("user.manage")
  @Post(":id/status")
  @ApiOperation({
    summary: "Suspend, blacklist or restore an account",
    description:
      "Ends their signed-in sessions immediately. Vehicles are unaffected — blacklisting a plate " +
      "is a separate act, because the kerb check reads the plate and not the owner.",
  })
  setStatus(
    @Param("id") id: string,
    @Body(zodPipe(CitizenStatusSchema)) dto: CitizenStatusDto,
    @CurrentUser() user: AuthenticatedUser,
    @ClientInfo() info: { ip?: string },
    @RequestId() requestId: string,
  ) {
    return this.citizens.setStatus(id, dto, user, { ...info, requestId });
  }

  @RequirePermissions("user.manage")
  @Post(":id/vehicles/:vehicleId/blacklist")
  @ApiOperation({
    summary: "Blacklist or clear one of their vehicles",
    description: "This is the check an attendant's handset actually makes when a session starts.",
  })
  setVehicleBlacklist(
    @Param("id") id: string,
    @Param("vehicleId") vehicleId: string,
    @Body(zodPipe(VehicleBlacklistSchema)) dto: VehicleBlacklistDto,
    @CurrentUser() user: AuthenticatedUser,
    @ClientInfo() info: { ip?: string },
    @RequestId() requestId: string,
  ) {
    return this.citizens.setVehicleBlacklist(id, vehicleId, dto, user, { ...info, requestId });
  }
}
