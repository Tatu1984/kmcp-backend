import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";

import { zodPipe } from "@/common/pipes/zod-validation.pipe";
import {
  ClientInfo,
  CurrentUser,
  Public,
  RequestId,
  RequirePermissions,
  type AuthenticatedUser,
} from "@/common/decorators/auth.decorators";
import { ZonesService } from "./zones.service";
import {
  AssignVendorSchema,
  CreateZoneSchema,
  NearbySchema,
  ResolveZoneSchema,
  UpdateZoneSchema,
  ZoneQuerySchema,
  ZoneStatusSchema,
  type AssignVendorDto,
  type CreateZoneDto,
  type NearbyDto,
  type ResolveZoneDto,
  type UpdateZoneDto,
  type ZoneQueryDto,
  type ZoneStatusDto,
} from "./dto/zone.dto";
import { z } from "zod";

const RetireSchema = z.object({ reason: z.string().trim().min(4).max(500) });

@ApiTags("Zones")
@ApiBearerAuth("bearer")
@Controller("zones")
export class ZonesController {
  constructor(private readonly zones: ZonesService) {}

  @Public()
  @Get("nearby")
  @ApiOperation({
    summary: "Open zones near a point, with live availability",
    description: "Public — this is what the citizen app map calls before the driver sets off.",
  })
  nearby(@Query(zodPipe(NearbySchema)) query: NearbyDto) {
    return this.zones.nearby(query);
  }

  @RequirePermissions("zone.read")
  @Get("resolve")
  @ApiOperation({
    summary: "Resolve a GPS fix to the zone the attendant is standing in",
    description:
      "Returns OUTSIDE_GEOFENCE when the point falls outside every assigned zone. The device " +
      "never decides this for itself.",
  })
  resolve(
    @Query(zodPipe(ResolveZoneSchema)) query: ResolveZoneDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.zones.resolveByLocation(query.lat, query.lng, user);
  }

  @RequirePermissions("zone.read")
  @Get("heatmap")
  @ApiOperation({ summary: "Occupancy across every zone in scope, for the dashboard heat map" })
  heatmap(@CurrentUser() user: AuthenticatedUser) {
    return this.zones.heatmap(user);
  }

  @RequirePermissions("zone.read")
  @Get()
  @ApiOperation({ summary: "List zones with live occupancy" })
  list(@Query(zodPipe(ZoneQuerySchema)) query: ZoneQueryDto, @CurrentUser() user: AuthenticatedUser) {
    return this.zones.list(query, user);
  }

  @RequirePermissions("zone.read")
  @Get(":id")
  @ApiOperation({ summary: "One zone with its vendor, slot counts and occupancy" })
  findOne(@Param("id") id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.zones.findOne(id, user);
  }

  @RequirePermissions("zone.read")
  @Get(":id/occupancy")
  @ApiOperation({ summary: "Live occupancy broken down by vehicle type and slot status" })
  occupancy(@Param("id") id: string) {
    return this.zones.occupancy(id);
  }

  @RequirePermissions("zone.write")
  @Post()
  @ApiOperation({ summary: "Create a zone" })
  create(
    @Body(zodPipe(CreateZoneSchema)) dto: CreateZoneDto,
    @CurrentUser() user: AuthenticatedUser,
    @ClientInfo() info: { ip?: string },
    @RequestId() requestId: string,
  ) {
    return this.zones.create(dto, user, { ...info, requestId });
  }

  @RequirePermissions("zone.write")
  @Patch(":id")
  @ApiOperation({ summary: "Update a zone" })
  update(
    @Param("id") id: string,
    @Body(zodPipe(UpdateZoneSchema)) dto: UpdateZoneDto,
    @CurrentUser() user: AuthenticatedUser,
    @ClientInfo() info: { ip?: string },
    @RequestId() requestId: string,
  ) {
    return this.zones.update(id, dto, user, { ...info, requestId });
  }

  @RequirePermissions("zone.status")
  @Post(":id/status")
  @ApiOperation({
    summary: "Open or close a zone",
    description:
      "Takes effect immediately for every app. Vehicles already parked keep their sessions and " +
      "are charged normally — only new sessions are blocked.",
  })
  changeStatus(
    @Param("id") id: string,
    @Body(zodPipe(ZoneStatusSchema)) dto: ZoneStatusDto,
    @CurrentUser() user: AuthenticatedUser,
    @ClientInfo() info: { ip?: string },
    @RequestId() requestId: string,
  ) {
    return this.zones.changeStatus(id, dto, user, { ...info, requestId });
  }

  @RequirePermissions("zone.write")
  @Post(":id/vendor")
  @ApiOperation({ summary: "Assign the zone to an approved vendor" })
  assignVendor(
    @Param("id") id: string,
    @Body(zodPipe(AssignVendorSchema)) dto: AssignVendorDto,
    @CurrentUser() user: AuthenticatedUser,
    @ClientInfo() info: { ip?: string },
    @RequestId() requestId: string,
  ) {
    return this.zones.assignVendor(id, dto.vendorId, user, { ...info, requestId });
  }

  @RequirePermissions("zone.write")
  @Delete(":id")
  @ApiOperation({
    summary: "Retire a zone",
    description:
      "Withdraws it from service and releases the vendor. Nothing is deleted — historic sessions, " +
      "payments and settlements stay for audit.",
  })
  remove(
    @Param("id") id: string,
    @Body(zodPipe(RetireSchema)) dto: { reason: string },
    @CurrentUser() user: AuthenticatedUser,
    @ClientInfo() info: { ip?: string },
    @RequestId() requestId: string,
  ) {
    return this.zones.remove(id, dto.reason, user, { ...info, requestId });
  }
}
