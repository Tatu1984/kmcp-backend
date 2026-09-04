import { Injectable, Logger } from "@nestjs/common";
import { NotificationChannel, Prisma } from "@prisma/client";

import { PrismaService } from "@/prisma/prisma.service";
import { AppException } from "@/common/errors/app.exception";
import { Paginated } from "@/common/interceptors/response.interceptor";
import { skipTake } from "@/common/dto/pagination.dto";
import type { AuthenticatedUser } from "@/common/decorators/auth.decorators";
import type { NotificationPayload, NotificationQueryDto } from "./dto/notification.dto";

/** What the portal renders for one alert. */
export interface NotificationView {
  id: string;
  template: string;
  title: string;
  body?: string;
  href?: string;
  read: boolean;
  createdAt: Date;
}

/**
 * In-app alerts for the people who sign in to the portal.
 *
 * Scope is the whole design. Every method below is written in terms of
 * `userId`, and the controller only ever passes the caller's own id — there is
 * no route that reads someone else's notifications, which is why these routes
 * carry no permission decorator: the row set *is* the authorisation.
 *
 * Delivery over SMS, WhatsApp and email now lives in `modules/messaging`, which
 * writes its own rows to this same table with the channel it actually used.
 * That is why every read below is scoped to `IN_APP` as well as to the user: a
 * receipt texted to a citizen is a delivery record, not an alert anyone should
 * find waiting in the portal's bell, and counting one in the unread badge would
 * be telling an officer they have mail that was never addressed to them.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async list(query: NotificationQueryDto, user: AuthenticatedUser): Promise<Paginated<NotificationView>> {
    const where: Prisma.NotificationWhereInput = {
      userId: user.id,
      channel: NotificationChannel.IN_APP,
      ...(query.unreadOnly ? { readAt: null } : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.notification.findMany({
        where,
        orderBy: { createdAt: "desc" },
        ...skipTake(query),
      }),
      this.prisma.notification.count({ where }),
    ]);

    return new Paginated(rows.map(toView), query.page, query.pageSize, total);
  }

  /** Just the number, for the bell. Cheap enough to poll. */
  async unreadCount(user: AuthenticatedUser): Promise<{ unread: number }> {
    const unread = await this.prisma.notification.count({
      where: { userId: user.id, channel: NotificationChannel.IN_APP, readAt: null },
    });
    return { unread };
  }

  async markRead(id: string, user: AuthenticatedUser): Promise<NotificationView> {
    // Scoped by userId as well as id, so a guessed id belonging to someone else
    // updates nothing and reports not-found rather than silently succeeding.
    const { count } = await this.prisma.notification.updateMany({
      where: { id, userId: user.id, channel: NotificationChannel.IN_APP, readAt: null },
      data: { readAt: new Date() },
    });

    const row = await this.prisma.notification.findFirst({
      where: { id, userId: user.id, channel: NotificationChannel.IN_APP },
    });
    if (!row) throw new AppException("NOT_FOUND");

    // count === 0 with a row present means it was already read. That is not an
    // error — marking a read notification read again is the same outcome.
    void count;
    return toView(row);
  }

  async markAllRead(user: AuthenticatedUser): Promise<{ marked: number }> {
    const { count } = await this.prisma.notification.updateMany({
      where: { userId: user.id, channel: NotificationChannel.IN_APP, readAt: null },
      data: { readAt: new Date() },
    });
    return { marked: count };
  }

  async dismiss(id: string, user: AuthenticatedUser): Promise<{ dismissed: true }> {
    // Scoped to IN_APP so "dismiss" can never delete a delivery record — the
    // proof that a receipt was sent is not the recipient's to throw away.
    const { count } = await this.prisma.notification.deleteMany({
      where: { id, userId: user.id, channel: NotificationChannel.IN_APP },
    });
    if (count === 0) throw new AppException("NOT_FOUND");
    return { dismissed: true };
  }

  /**
   * Raises an alert. The write side, for other modules to call.
   *
   * Deliberately never throws into its caller: a settlement must still be
   * approved if the notification write fails. An alert nobody received is a
   * lesser fault than a workflow that rolled back because of one.
   */
  async raise(input: {
    userId: string;
    template: string;
    payload: NotificationPayload;
    channel?: NotificationChannel;
  }): Promise<void> {
    try {
      await this.prisma.notification.create({
        data: {
          userId: input.userId,
          channel: input.channel ?? NotificationChannel.IN_APP,
          template: input.template,
          payload: input.payload as unknown as Prisma.InputJsonValue,
          status: "SENT",
          sentAt: new Date(),
        },
      });
    } catch (error) {
      this.logger.error(`Could not raise "${input.template}" for ${input.userId}: ${String(error)}`);
    }
  }

  /** The same alert to everyone holding a permission — an officer broadcast. */
  async raiseForPermission(
    permission: string,
    input: { template: string; payload: NotificationPayload },
  ): Promise<void> {
    const roles = await this.prisma.role.findMany({
      where: { OR: [{ isSuperuser: true }, { permissions: { has: permission } }] },
      select: { code: true },
    });
    const recipients = await this.prisma.user.findMany({
      where: { role: { in: roles.map((r) => r.code) }, status: "ACTIVE", deletedAt: null },
      select: { id: true },
    });

    for (const recipient of recipients) {
      await this.raise({ userId: recipient.id, ...input });
    }
  }
}

function toView(row: {
  id: string;
  template: string;
  payload: Prisma.JsonValue;
  readAt: Date | null;
  createdAt: Date;
}): NotificationView {
  // The payload is a Json column, so it is `unknown` until read. A row written
  // by an older template version may be missing a field; the template name is
  // always there and is a usable last resort for a title.
  const payload = (row.payload ?? {}) as Partial<NotificationPayload>;
  return {
    id: row.id,
    template: row.template,
    title: payload.title ?? row.template,
    body: payload.body,
    href: payload.href,
    read: row.readAt !== null,
    createdAt: row.createdAt,
  };
}
