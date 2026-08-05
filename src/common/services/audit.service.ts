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
 * The audit trail is append-only and never fails a request. If writing the
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

  async recordLogin(params: {
    userId?: string | null;
    identifier: string;
    success: boolean;
    reason?: string;
    ip?: string;
    deviceId?: string;
  }): Promise<void> {
    try {
      await this.prisma.loginLog.create({
        data: {
          userId: params.userId ?? null,
          identifier: params.identifier,
          success: params.success,
          reason: params.reason ?? null,
          ip: params.ip ?? null,
          deviceId: params.deviceId ?? null,
        },
      });
    } catch (error) {
      this.logger.error("Failed to write login log", error instanceof Error ? error.stack : String(error));
    }
  }
}
