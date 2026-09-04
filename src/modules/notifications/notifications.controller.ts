import { Controller, Delete, Get, Param, Post, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";

import { zodPipe } from "@/common/pipes/zod-validation.pipe";
import { CurrentUser, type AuthenticatedUser } from "@/common/decorators/auth.decorators";
import { NotificationsService } from "./notifications.service";
import { NotificationQuerySchema, type NotificationQueryDto } from "./dto/notification.dto";

/**
 * The signed-in account's own alerts.
 *
 * No `@RequirePermissions` here, and that is deliberate rather than an
 * oversight: every route is scoped to `user.id` in the service, so the caller
 * can only ever reach their own rows. This is the same reasoning that leaves
 * `/auth/me` and `/auth/devices` undecorated — a permission check would be
 * asking "may you read notifications?" when the only answer that matters is
 * "these are yours".
 */
@ApiTags("Notifications")
@ApiBearerAuth("bearer")
@Controller("notifications")
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  @ApiOperation({ summary: "Your alerts, newest first" })
  list(
    @Query(zodPipe(NotificationQuerySchema)) query: NotificationQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.notifications.list(query, user);
  }

  @Get("unread-count")
  @ApiOperation({
    summary: "How many of your alerts are unread",
    description: "Cheap enough for the portal to poll for its badge.",
  })
  unreadCount(@CurrentUser() user: AuthenticatedUser) {
    return this.notifications.unreadCount(user);
  }

  @Post("read-all")
  @ApiOperation({ summary: "Mark every unread alert as read" })
  markAllRead(@CurrentUser() user: AuthenticatedUser) {
    return this.notifications.markAllRead(user);
  }

  @Post(":id/read")
  @ApiOperation({ summary: "Mark one alert as read" })
  markRead(@Param("id") id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.notifications.markRead(id, user);
  }

  @Delete(":id")
  @ApiOperation({ summary: "Dismiss one alert" })
  dismiss(@Param("id") id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.notifications.dismiss(id, user);
  }
}
