import { Body, Controller, Delete, Get, Param, Post, Req } from "@nestjs/common";
import type { Request } from "express";
import { Throttle } from "@nestjs/throttler";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { UserRole } from "@prisma/client";

import { zodPipe } from "@/common/pipes/zod-validation.pipe";
import {
  CurrentUser,
  Public,
  Roles,
  SkipDeviceBinding,
  type AuthenticatedUser,
} from "@/common/decorators/auth.decorators";
import { AuthService } from "./auth.service";
import {
  BindDeviceSchema,
  ChangePasswordSchema,
  LoginSchema,
  OtpRequestSchema,
  OtpVerifySchema,
  RefreshSchema,
  TwoFactorSchema,
  VerifyTotpSchema,
  type BindDeviceDto,
  type ChangePasswordDto,
  type LoginDto,
  type OtpRequestDto,
  type OtpVerifyDto,
  type RefreshDto,
  type TwoFactorDto,
  type VerifyTotpDto,
} from "./dto/auth.dto";

@ApiTags("Auth")
@Controller("auth")
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Throttle({ strict: { ttl: 60_000, limit: 10 } })
  @Post("login")
  @ApiOperation({
    summary: "Sign in with email and password",
    description:
      "Returns tokens directly, or `two_factor_required` with a challenge id when the account " +
      "has an authenticator enrolled. 2FA is mandatory for admin roles.",
  })
  login(@Body(zodPipe(LoginSchema)) dto: LoginDto, @Req() req: Request) {
    return this.auth.login(dto, req);
  }

  @Public()
  @Throttle({ strict: { ttl: 60_000, limit: 10 } })
  @Post("two-factor/verify")
  @ApiOperation({ summary: "Complete sign-in with a 6-digit authenticator code" })
  verifyTwoFactor(@Body(zodPipe(TwoFactorSchema)) dto: TwoFactorDto, @Req() req: Request) {
    return this.auth.verifyTwoFactor(dto, req);
  }

  @Public()
  @Throttle({ strict: { ttl: 300_000, limit: 5 } })
  @Post("otp/request")
  @ApiOperation({
    summary: "Send a login OTP to a citizen's mobile",
    description: "Outside production the code is returned as `devCode` so the flow is testable.",
  })
  requestOtp(@Body(zodPipe(OtpRequestSchema)) dto: OtpRequestDto) {
    return this.auth.requestOtp(dto);
  }

  @Public()
  @Throttle({ strict: { ttl: 300_000, limit: 10 } })
  @Post("otp/verify")
  @ApiOperation({
    summary: "Verify a citizen OTP and sign in",
    description: "Creates the citizen account on first successful verification.",
  })
  verifyOtp(@Body(zodPipe(OtpVerifySchema)) dto: OtpVerifyDto, @Req() req: Request) {
    return this.auth.verifyOtp(dto, req);
  }

  @Public()
  @Post("refresh")
  @ApiOperation({
    summary: "Exchange a refresh token for a new pair",
    description:
      "Refresh tokens are single-use. Presenting one twice revokes the whole token family and " +
      "returns TOKEN_REUSED.",
  })
  refresh(@Body(zodPipe(RefreshSchema)) dto: RefreshDto) {
    return this.auth.refresh(dto.refreshToken);
  }

  @Public()
  @Post("logout")
  @ApiOperation({ summary: "Revoke the supplied refresh token" })
  logout(@Body(zodPipe(RefreshSchema)) dto: RefreshDto) {
    return this.auth.logout(dto.refreshToken);
  }

  @ApiBearerAuth("bearer")
  @SkipDeviceBinding()
  @Post("logout-all")
  @ApiOperation({ summary: "Sign out of every device" })
  logoutAll(@CurrentUser() user: AuthenticatedUser) {
    return this.auth.logoutEverywhere(user.id);
  }

  @ApiBearerAuth("bearer")
  @SkipDeviceBinding()
  @Get("me")
  @ApiOperation({ summary: "The signed-in principal, its role and zone scope" })
  me(@CurrentUser() user: AuthenticatedUser) {
    return this.auth.me(user);
  }

  @ApiBearerAuth("bearer")
  @SkipDeviceBinding()
  @Post("password/change")
  @ApiOperation({
    summary: "Change your own password",
    description: "Signs out every other session on success.",
  })
  changePassword(
    @CurrentUser() user: AuthenticatedUser,
    @Body(zodPipe(ChangePasswordSchema)) dto: ChangePasswordDto,
  ) {
    return this.auth.changePassword(user.id, dto);
  }

  @ApiBearerAuth("bearer")
  @SkipDeviceBinding()
  @Post("two-factor/setup")
  @ApiOperation({ summary: "Begin authenticator enrolment; returns the otpauth URL" })
  setupTwoFactor(@CurrentUser() user: AuthenticatedUser) {
    return this.auth.setupTwoFactor(user.id);
  }

  @ApiBearerAuth("bearer")
  @SkipDeviceBinding()
  @Post("two-factor/confirm")
  @ApiOperation({ summary: "Confirm enrolment with the first generated code" })
  confirmTwoFactor(
    @CurrentUser() user: AuthenticatedUser,
    @Body(zodPipe(VerifyTotpSchema)) dto: VerifyTotpDto,
  ) {
    return this.auth.confirmTwoFactor(user.id, dto.code);
  }

  @ApiBearerAuth("bearer")
  @Roles(UserRole.SUPER_ADMIN)
  @Post("two-factor/disable/:userId")
  @ApiOperation({ summary: "Remove an authenticator from an account (Super Admin only)" })
  disableTwoFactor(@Param("userId") userId: string) {
    return this.auth.disableTwoFactor(userId);
  }

  @ApiBearerAuth("bearer")
  @SkipDeviceBinding()
  @Post("device/bind")
  @ApiOperation({
    summary: "Register this device against the account",
    description:
      "Attendant tokens only work from a bound device. This is the one route they may call " +
      "from an unregistered handset.",
  })
  bindDevice(
    @CurrentUser() user: AuthenticatedUser,
    @Body(zodPipe(BindDeviceSchema)) dto: BindDeviceDto,
  ) {
    return this.auth.upsertDevice(user.id, dto);
  }

  @ApiBearerAuth("bearer")
  @SkipDeviceBinding()
  @Get("devices")
  @ApiOperation({ summary: "Devices bound to your account" })
  listDevices(@CurrentUser() user: AuthenticatedUser) {
    return this.auth.listDevices(user.id);
  }

  @ApiBearerAuth("bearer")
  @SkipDeviceBinding()
  @Delete("devices/:id")
  @ApiOperation({ summary: "Unbind a device" })
  unbindDevice(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.auth.unbindDevice(user.id, id);
  }
}
