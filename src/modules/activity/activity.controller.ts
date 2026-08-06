import { Body, Controller, Delete, Get, Param, Post, Query, Req } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Request } from "express";

import { zodPipe } from "@/common/pipes/zod-validation.pipe";
import {
  ClientInfo,
  CurrentUser,
  RequestId,
  RequirePermissions,
  SkipDeviceBinding,
  type AuthenticatedUser,
} from "@/common/decorators/auth.decorators";
import { ActivityService } from "./activity.service";
import {
  ActivityQuerySchema,
  ApproveEventSchema,
  ConsentSchema,
  RevokeSessionSchema,
  type ActivityQueryDto,
  type ApproveEventDto,
  type ConsentDto,
  type RevokeSessionDto,
} from "./dto/activity.dto";

@ApiTags("Activity monitor")
@ApiBearerAuth("bearer")
@Controller()
export class ActivityController {
  constructor(private readonly activity: ActivityService) {}

  // ------------------------------------------------------------ admin views

  @RequirePermissions("audit.read")
  @Get("activity/overview")
  @ApiOperation({
    summary: "Sign-in activity at a glance",
    description: "Counts, live sessions, the places people signed in from, and the riskiest events.",
  })
  overview() {
    return this.activity.overview();
  }

  @RequirePermissions("audit.read")
  @Get("activity/events")
  @ApiOperation({
    summary: "Every sign-in attempt, with who, where and from what",
    description:
      "IP, city, locality, ISP, ASN, VPN detection, device, browser, OS, and the anomalies the " +
      "engine flagged. Failed attempts are recorded even for accounts that do not exist.",
  })
  events(@Query(zodPipe(ActivityQuerySchema)) query: ActivityQueryDto) {
    return this.activity.events_(query);
  }

  @RequirePermissions("audit.read")
  @Get("activity/users/:userId")
  @ApiOperation({
    summary: "One account's full history",
    description: "Sign-ins, sessions, bound devices and the places it habitually connects from.",
  })
  timeline(@Param("userId") userId: string) {
    return this.activity.timeline(userId);
  }

  @RequirePermissions("audit.read")
  @Get("activity/sessions")
  @ApiOperation({
    summary: "Live sessions",
    description:
      "Each row carries how many concurrent sessions that account holds — more than one is the " +
      "shape account-sharing takes.",
  })
  sessions() {
    return this.activity.liveSessions();
  }

  @RequirePermissions("user.manage")
  @Delete("activity/sessions/:sessionId")
  @ApiOperation({ summary: "Force a session to end immediately" })
  revokeSession(
    @Param("sessionId") sessionId: string,
    @Body(zodPipe(RevokeSessionSchema)) dto: RevokeSessionDto,
    @CurrentUser() user: AuthenticatedUser,
    @ClientInfo() info: { ip?: string },
    @RequestId() requestId: string,
  ) {
    return this.activity.revokeSession(sessionId, dto.reason, user, { ...info, requestId });
  }

  // ------------------------------------------------------------------ trust

  @RequirePermissions("user.manage")
  @Post("activity/events/:id/approve")
  @ApiOperation({
    summary: "Mark a flagged sign-in as legitimate",
    description: "Allowlists that account and IP so the same place stops being flagged.",
  })
  approve(
    @Param("id") id: string,
    @Body(zodPipe(ApproveEventSchema)) dto: ApproveEventDto,
    @CurrentUser() user: AuthenticatedUser,
    @ClientInfo() info: { ip?: string },
    @RequestId() requestId: string,
  ) {
    return this.activity.approve(id, dto, user, { ...info, requestId });
  }

  @RequirePermissions("audit.read")
  @Get("activity/trusted")
  @ApiOperation({ summary: "Approved account and address pairs" })
  listTrusted() {
    return this.activity.listTrusted();
  }

  @RequirePermissions("user.manage")
  @Delete("activity/trusted/:id")
  @ApiOperation({ summary: "Withdraw a trusted location" })
  revokeTrust(
    @Param("id") id: string,
    @CurrentUser() user: AuthenticatedUser,
    @ClientInfo() info: { ip?: string },
    @RequestId() requestId: string,
  ) {
    return this.activity.revokeTrust(id, user, { ...info, requestId });
  }

  // ---------------------------------------------------------------- consent

  @SkipDeviceBinding()
  @Get("auth/location-consent")
  @ApiOperation({ summary: "Your own precise-location consent state" })
  getConsent(@CurrentUser() user: AuthenticatedUser) {
    return this.activity.getConsent(user);
  }

  @SkipDeviceBinding()
  @Post("auth/location-consent")
  @ApiOperation({
    summary: "Grant or withdraw precise-location sharing",
    description:
      "Precise GPS is only ever stored with explicit consent. Withdrawing it erases the stored " +
      "fix rather than merely stopping new ones.",
  })
  setConsent(
    @CurrentUser() user: AuthenticatedUser,
    @Body(zodPipe(ConsentSchema)) dto: ConsentDto,
    @Req() req: Request,
  ) {
    return this.activity.setConsent(user, dto, req.header("user-agent"));
  }
}
