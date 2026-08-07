import { Injectable, Logger } from "@nestjs/common";

import { PrismaService } from "@/prisma/prisma.service";
import type { Permission, RoleCode } from "./permissions";

export interface ResolvedRole {
  code: RoleCode;
  label: string;
  description: string | null;
  permissions: Set<string>;
  isSystem: boolean;
  isZoneScoped: boolean;
  isSuperuser: boolean;
}

/**
 * Who may do what, read from the database.
 *
 * This sits in front of every authenticated request, so it is cached in the
 * process rather than queried each time — an uncached lookup would put a round
 * trip to Neon ahead of every call an attendant's handset makes.
 *
 * The cache is short-lived and cleared outright whenever a role changes, so a
 * revoked permission takes effect at once on the instance that made the change
 * and within `TTL_MS` everywhere else. That window is the price of not querying
 * on every request; it is bounded, and revoking someone's sessions — which the
 * role editor does — closes it immediately for the person who matters.
 */
@Injectable()
export class RolesService {
  private readonly logger = new Logger(RolesService.name);

  private cache: Map<RoleCode, ResolvedRole> | null = null;
  private loadedAt = 0;
  private inFlight: Promise<Map<RoleCode, ResolvedRole>> | null = null;

  /** Long enough to be worth having, short enough that drift is measured in seconds. */
  private static readonly TTL_MS = 30_000;

  constructor(private readonly prisma: PrismaService) {}

  private async all(): Promise<Map<RoleCode, ResolvedRole>> {
    const fresh = this.cache && Date.now() - this.loadedAt < RolesService.TTL_MS;
    if (fresh) return this.cache!;

    // Concurrent requests on a cold cache share one query rather than each
    // firing their own.
    this.inFlight ??= (async () => {
      try {
        const rows = await this.prisma.role.findMany();
        const map = new Map<RoleCode, ResolvedRole>(
          rows.map((row) => [
            row.code,
            {
              code: row.code,
              label: row.label,
              description: row.description,
              permissions: new Set(row.permissions),
              isSystem: row.isSystem,
              isZoneScoped: row.isZoneScoped,
              isSuperuser: row.isSuperuser,
            },
          ]),
        );
        this.cache = map;
        this.loadedAt = Date.now();
        return map;
      } finally {
        this.inFlight = null;
      }
    })();

    return this.inFlight;
  }

  /** Call after any write to a role. */
  invalidate(): void {
    this.cache = null;
    this.loadedAt = 0;
  }

  async get(code: RoleCode): Promise<ResolvedRole | null> {
    return (await this.all()).get(code) ?? null;
  }

  async list(): Promise<ResolvedRole[]> {
    return [...(await this.all()).values()].sort((a, b) => a.code.localeCompare(b.code));
  }

  /**
   * The authorisation decision.
   *
   * An unknown role is refused rather than waved through. If a role has been
   * deleted from under a live token, the safe reading of "no such role" is no
   * access at all.
   */
  async can(code: RoleCode, permission: Permission): Promise<boolean> {
    const role = await this.get(code);
    if (!role) {
      this.logger.warn(`Refused a request from unknown role "${code}"`);
      return false;
    }
    if (role.isSuperuser) return true;
    return role.permissions.has(permission);
  }

  async isZoneScoped(code: RoleCode): Promise<boolean> {
    return (await this.get(code))?.isZoneScoped ?? false;
  }
}
