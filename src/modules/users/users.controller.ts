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
import { UsersService } from "./users.service";
import {
  AssignZonesSchema,
  ChangeRoleSchema,
  ChangeUserStatusSchema,
  CreateUserSchema,
  ResetPasswordSchema,
  UpdateUserSchema,
  UserQuerySchema,
  type AssignZonesDto,
  type ChangeRoleDto,
  type ChangeUserStatusDto,
  type CreateUserDto,
  type ResetPasswordDto,
  type UpdateUserDto,
  type UserQueryDto,
} from "./dto/user.dto";

/**
 * Portal staff administration. Vendor, attendant and citizen accounts are
 * managed from their own screens, where the records attached to the login are
 * created alongside it.
 */
@ApiTags("Users")
@ApiBearerAuth("bearer")
@Controller("users")
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @RequirePermissions("user.manage")
  @Get()
  @ApiOperation({ summary: "Portal accounts" })
  list(@Query(zodPipe(UserQuerySchema)) query: UserQueryDto) {
    return this.users.list(query);
  }

  @RequirePermissions("user.manage")
  @Get(":id")
  @ApiOperation({ summary: "One account with its zone scope, live sessions and devices" })
  findOne(@Param("id") id: string) {
    return this.users.findOne(id);
  }

  @RequirePermissions("user.manage")
  @Post()
  @ApiOperation({ summary: "Create a portal account" })
  create(
    @Body(zodPipe(CreateUserSchema)) dto: CreateUserDto,
    @CurrentUser() user: AuthenticatedUser,
    @ClientInfo() info: { ip?: string },
    @RequestId() requestId: string,
  ) {
    return this.users.create(dto, user, { ...info, requestId });
  }

  @RequirePermissions("user.manage")
  @Patch(":id")
  @ApiOperation({ summary: "Update name, email or phone" })
  update(
    @Param("id") id: string,
    @Body(zodPipe(UpdateUserSchema)) dto: UpdateUserDto,
    @CurrentUser() user: AuthenticatedUser,
    @ClientInfo() info: { ip?: string },
    @RequestId() requestId: string,
  ) {
    return this.users.update(id, dto, user, { ...info, requestId });
  }

  @RequirePermissions("user.manage")
  @Post(":id/role")
  @ApiOperation({
    summary: "Change an account's role",
    description:
      "Ends their sessions so the new permissions apply immediately. Nobody may change their own role, and the last active Super Admin is protected.",
  })
  changeRole(
    @Param("id") id: string,
    @Body(zodPipe(ChangeRoleSchema)) dto: ChangeRoleDto,
    @CurrentUser() user: AuthenticatedUser,
    @ClientInfo() info: { ip?: string },
    @RequestId() requestId: string,
  ) {
    return this.users.changeRole(id, dto, user, { ...info, requestId });
  }

  @RequirePermissions("user.manage")
  @Post(":id/status")
  @ApiOperation({
    summary: "Suspend, reinstate or blacklist an account",
    description: "Anything other than ACTIVE ends every live session.",
  })
  changeStatus(
    @Param("id") id: string,
    @Body(zodPipe(ChangeUserStatusSchema)) dto: ChangeUserStatusDto,
    @CurrentUser() user: AuthenticatedUser,
    @ClientInfo() info: { ip?: string },
    @RequestId() requestId: string,
  ) {
    return this.users.changeStatus(id, dto, user, { ...info, requestId });
  }

  @RequirePermissions("user.manage")
  @Post(":id/password-reset")
  @ApiOperation({
    summary: "Set a new password for an account",
    description: "Ends every live session. The password is never written to the audit trail — only the reason.",
  })
  resetPassword(
    @Param("id") id: string,
    @Body(zodPipe(ResetPasswordSchema)) dto: ResetPasswordDto,
    @CurrentUser() user: AuthenticatedUser,
    @ClientInfo() info: { ip?: string },
    @RequestId() requestId: string,
  ) {
    return this.users.resetPassword(id, dto, user, { ...info, requestId });
  }

  @RequirePermissions("user.manage")
  @Post(":id/zones")
  @ApiOperation({
    summary: "Set which zones a zone officer may see",
    description: "An empty list means unrestricted.",
  })
  assignZones(
    @Param("id") id: string,
    @Body(zodPipe(AssignZonesSchema)) dto: AssignZonesDto,
    @CurrentUser() user: AuthenticatedUser,
    @ClientInfo() info: { ip?: string },
    @RequestId() requestId: string,
  ) {
    return this.users.assignZones(id, dto, user, { ...info, requestId });
  }
}
