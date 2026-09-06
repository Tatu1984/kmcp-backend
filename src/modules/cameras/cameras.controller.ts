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

  /**
   * `camera.manage` rather than `camera.view`, because this is the plumbing
   * rather than the picture: the address the gateway pulls from, and whether
   * credentials are stored. Neither the username nor the password is in the
   * answer — see CamerasService.connection.
   */
  @RequirePermissions("camera.manage")
  @Get(":id/connection")
  @ApiOperation({
    summary: "How a camera is plumbed in",
    description:
      "For filling in the edit form. The RTSP address comes back with any credentials " +
      "stripped out of it, and the stored username and password never come back at all.",
  })
  connection(@Param("id") id: string) {
    return this.cameras.connection(id);
  }

  @RequirePermissions("camera.manage")
  @Post(":id/probe")
  @ApiOperation({
    summary: "Ask the camera whether it is there",
    description:
      "Opens the stream with ffprobe and records what answered: resolution, frame rate and " +
      "codec, or the reason it did not. Takes up to eight seconds. A status somebody set by " +
      "hand — maintenance, decommissioned — is reported on but not overwritten.",
  })
  probe(
    @Param("id") id: string,
    @CurrentUser() user: AuthenticatedUser,
    @ClientInfo() ip: string,
    @RequestId() requestId: string,
  ) {
    return this.cameras.probe(id, user, { ip, requestId });
  }

  @RequirePermissions("camera.manage")
  @Delete(":id")
  @ApiOperation({
    summary: "Remove a camera",
    description:
      "For one that was never there — a duplicate, a typo, a plan that changed. A camera that " +
      "exists but is off the network should be marked out of service instead, which keeps its " +
      "history.",
  })
  remove(
    @Param("id") id: string,
    @CurrentUser() user: AuthenticatedUser,
    @ClientInfo() ip: string,
    @RequestId() requestId: string,
  ) {
    return this.cameras.remove(id, user, { ip, requestId });
  }
}
