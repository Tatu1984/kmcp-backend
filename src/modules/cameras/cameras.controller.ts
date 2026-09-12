import { Body, Controller, Delete, Get, Param, Post, Req } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { SkipThrottle } from "@nestjs/throttler";
import type { Request } from "express";

import { zodPipe } from "@/common/pipes/zod-validation.pipe";
import { Roles } from "@/common/decorators/auth.decorators";
import { CamerasService } from "./cameras.service";
import { CreateCameraSchema, type CreateCameraDto } from "./dto/camera.dto";

/**
 * Camera administration — registering the cameras whose live HLS the Edge Agent
 * pushes in, and watching them. Every route is restricted to administrators
 * (`SUPER_ADMIN`, `ADMIN`); nobody else sees a live street.
 *
 * The ingest and playback traffic itself is on a separate controller
 * (`IngestController`) mounted outside the API prefix, because the Edge Agent
 * authenticates with a per-camera token rather than a user session.
 */
@ApiTags("Cameras")
@ApiBearerAuth("bearer")
@Roles("SUPER_ADMIN", "ADMIN")
@Controller("cameras")
export class CamerasController {
  constructor(private readonly cameras: CamerasService) {}

  /** The origin the operator's Edge Agent should PUT to, and the browser plays from. */
  private baseUrl(req: Request): string {
    const env = process.env.PUBLIC_APP_URL;
    if (env) return env.replace(/\/+$/, "");
    const proto = (req.headers["x-forwarded-proto"] as string) || req.protocol || "https";
    const host = req.headers["x-forwarded-host"] || req.headers.host;
    return host ? `${proto}://${host}` : "";
  }

  // The wall polls this every several seconds for live status, so it is exempt
  // from the rate limiter — it would otherwise share the per-IP budget with the
  // admin's own playback traffic and tip the dashboard into 429s. It stays
  // admin-gated (@Roles above); the write routes below keep normal throttling.
  // Both named throttlers, or the unlisted one still applies (see IngestController).
  @SkipThrottle({ default: true, strict: true })
  @Get()
  @ApiOperation({ summary: "Every camera, with live status" })
  list(@Req() req: Request) {
    return this.cameras.list(this.baseUrl(req));
  }

  @Post()
  @ApiOperation({
    summary: "Register a camera",
    description:
      "Returns the ingest URL and a one-time token to paste into the Edge Agent. The token " +
      "is shown only here — only its hash is stored.",
  })
  create(@Body(zodPipe(CreateCameraSchema)) dto: CreateCameraDto, @Req() req: Request) {
    return this.cameras.create(dto, this.baseUrl(req));
  }

  @Post(":id/rotate-token")
  @ApiOperation({
    summary: "Rotate a camera's ingest token",
    description: "Revokes the old token and returns a new one, shown once.",
  })
  rotateToken(@Param("id") id: string, @Req() req: Request) {
    return this.cameras.rotateToken(id, this.baseUrl(req));
  }

  @Delete(":id")
  @ApiOperation({ summary: "Remove a camera" })
  remove(@Param("id") id: string) {
    return this.cameras.remove(id);
  }
}
