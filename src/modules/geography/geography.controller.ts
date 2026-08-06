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
import { GeographyService } from "./geography.service";
import {
  CreateStreetSchema,
  CreateWardSchema,
  StreetQuerySchema,
  UpdateStreetSchema,
  UpdateWardSchema,
  WardQuerySchema,
  type CreateStreetDto,
  type CreateWardDto,
  type StreetQueryDto,
  type UpdateStreetDto,
  type UpdateWardDto,
  type WardQueryDto,
} from "./dto/geography.dto";

/**
 * Municipal geography: wards, and the streets within them. Zones reference both,
 * which is what lets revenue be reported the way the authority is organised.
 */
@ApiTags("Geography")
@ApiBearerAuth("bearer")
@Controller()
export class GeographyController {
  constructor(private readonly geography: GeographyService) {}

  @RequirePermissions("zone.read")
  @Get("wards")
  @ApiOperation({ summary: "Wards, with street and zone counts" })
  listWards(@Query(zodPipe(WardQuerySchema)) query: WardQueryDto) {
    return this.geography.listWards(query);
  }

  @RequirePermissions("zone.read")
  @Get("wards/:id")
  @ApiOperation({ summary: "One ward with its streets" })
  findWard(@Param("id") id: string) {
    return this.geography.findWard(id);
  }

  @RequirePermissions("zone.write")
  @Post("wards")
  @ApiOperation({ summary: "Add a ward" })
  createWard(
    @Body(zodPipe(CreateWardSchema)) dto: CreateWardDto,
    @CurrentUser() user: AuthenticatedUser,
    @ClientInfo() info: { ip?: string },
    @RequestId() requestId: string,
  ) {
    return this.geography.createWard(dto, user, { ...info, requestId });
  }

  @RequirePermissions("zone.write")
  @Patch("wards/:id")
  @ApiOperation({ summary: "Rename or recode a ward" })
  updateWard(
    @Param("id") id: string,
    @Body(zodPipe(UpdateWardSchema)) dto: UpdateWardDto,
    @CurrentUser() user: AuthenticatedUser,
    @ClientInfo() info: { ip?: string },
    @RequestId() requestId: string,
  ) {
    return this.geography.updateWard(id, dto, user, { ...info, requestId });
  }

  @RequirePermissions("zone.write")
  @Delete("wards/:id")
  @ApiOperation({
    summary: "Remove an empty ward",
    description: "Refused while any street or zone still references it.",
  })
  removeWard(
    @Param("id") id: string,
    @CurrentUser() user: AuthenticatedUser,
    @ClientInfo() info: { ip?: string },
    @RequestId() requestId: string,
  ) {
    return this.geography.removeWard(id, user, { ...info, requestId });
  }

  @RequirePermissions("zone.read")
  @Get("streets")
  @ApiOperation({ summary: "Streets, optionally filtered to one ward" })
  listStreets(@Query(zodPipe(StreetQuerySchema)) query: StreetQueryDto) {
    return this.geography.listStreets(query);
  }

  @RequirePermissions("zone.write")
  @Post("streets")
  @ApiOperation({ summary: "Add a street to a ward" })
  createStreet(
    @Body(zodPipe(CreateStreetSchema)) dto: CreateStreetDto,
    @CurrentUser() user: AuthenticatedUser,
    @ClientInfo() info: { ip?: string },
    @RequestId() requestId: string,
  ) {
    return this.geography.createStreet(dto, user, { ...info, requestId });
  }

  @RequirePermissions("zone.write")
  @Patch("streets/:id")
  @ApiOperation({ summary: "Rename a street or move it to another ward" })
  updateStreet(
    @Param("id") id: string,
    @Body(zodPipe(UpdateStreetSchema)) dto: UpdateStreetDto,
    @CurrentUser() user: AuthenticatedUser,
    @ClientInfo() info: { ip?: string },
    @RequestId() requestId: string,
  ) {
    return this.geography.updateStreet(id, dto, user, { ...info, requestId });
  }

  @RequirePermissions("zone.write")
  @Delete("streets/:id")
  @ApiOperation({ summary: "Remove a street no zone references" })
  removeStreet(
    @Param("id") id: string,
    @CurrentUser() user: AuthenticatedUser,
    @ClientInfo() info: { ip?: string },
    @RequestId() requestId: string,
  ) {
    return this.geography.removeStreet(id, user, { ...info, requestId });
  }
}
