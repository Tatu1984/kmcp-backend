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
import { CamerasService } from "./cameras.service";
import {
  CameraQuerySchema,
  CreateCameraSchema,
  UpdateCameraSchema,
  type CameraQueryDto,
  type CreateCameraDto,
  type UpdateCameraDto,
} from "./dto/camera.dto";

@ApiTags("Cameras")
@ApiBearerAuth("bearer")
@Controller("cameras")
export class CamerasController {
  constructor(private readonly cameras: CamerasService) {}

  @RequirePermissions("camera.view")
  @Get()
  @ApiOperation({
    summary: "Cameras on a road",
    description:
      "Filter by street, or by zone to get the cameras on that zone's road. Stream keys are " +
      "never returned.",
  })
  list(
    @Query(zodPipe(CameraQuerySchema)) query: CameraQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.cameras.list(query, user);
  }

  @RequirePermissions("camera.view")
  @Get("health")
  @ApiOperation({
    summary: "How many cameras are dark",
    description: "The question actually asked on opening the list. Counts by status.",
  })
  health() {
    return this.cameras.health();
  }

  @RequirePermissions("camera.view")
  @Get(":id")
  @ApiOperation({ summary: "One camera" })
  get(@Param("id") id: string) {
    return this.cameras.get(id);
  }

  @RequirePermissions("camera.view")
  @Get(":id/playback")
  @ApiOperation({
    summary: "Where to play this camera from",
    description:
      "Answers `available: false` with a reason while no streaming gateway is deployed, so a " +
      "screen can say which piece is missing rather than showing a dead player. Every call is " +
      "recorded to the audit trail, whether or not anything plays.",
  })
  playback(
    @Param("id") id: string,
    @CurrentUser() user: AuthenticatedUser,
    @ClientInfo() ip: string,
    @RequestId() requestId: string,
  ) {
    return this.cameras.playback(id, user, { ip, requestId });
  }

  @RequirePermissions("camera.manage")
  @Post()
  @ApiOperation({ summary: "Register a camera" })
  create(
    @Body(zodPipe(CreateCameraSchema)) dto: CreateCameraDto,
    @CurrentUser() user: AuthenticatedUser,
    @ClientInfo() ip: string,
    @RequestId() requestId: string,
  ) {
    return this.cameras.create(dto, user, { ip, requestId });
  }

  @RequirePermissions("camera.manage")
  @Patch(":id")
  @ApiOperation({ summary: "Edit a camera" })
  update(
    @Param("id") id: string,
    @Body(zodPipe(UpdateCameraSchema)) dto: UpdateCameraDto,
    @CurrentUser() user: AuthenticatedUser,
    @ClientInfo() ip: string,
    @RequestId() requestId: string,
  ) {
    return this.cameras.update(id, dto, user, { ip, requestId });
  }
}
