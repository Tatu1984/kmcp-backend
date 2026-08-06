import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "@/prisma/prisma.service";
import type { AuthenticatedUser } from "../decorators/auth.decorators";

export interface AuditContext {
  actor?: AuthenticatedUser | null;
  ip?: string;
  userAgent?: string;
  requestId?: string;
}

export interface AuditEntry extends AuditContext {
  action: string;
  entity: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
}

/**
 * Business-mutation audit trail. Sign-in activity lives in AuthEventService,
 * which captures the network, location and device context this one does not.
 *
 * The trail is append-only and never fails a request. If writing the
 * entry throws we log loudly and let the business operation stand — losing an
 * audit row is bad, but rolling back a citizen's paid parking session is worse.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  async record(entry: AuditEntry): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          actorUserId: entry.actor?.id ?? null,
          action: entry.action,
          entity: entry.entity,
          entityId: entry.entityId,
          before: (entry.before ?? undefined) as never,
          after: (entry.after ?? undefined) as never,
          ip: entry.ip ?? null,
          userAgent: entry.userAgent ?? null,
          deviceId: entry.actor?.deviceId ?? null,
          requestId: entry.requestId ?? null,
        },
      });
    } catch (error) {
      this.logger.error(
        `Failed to write audit entry ${entry.action} on ${entry.entity}:${entry.entityId}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

}
