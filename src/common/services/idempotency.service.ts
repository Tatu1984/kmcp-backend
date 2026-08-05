import { Injectable } from "@nestjs/common";
import { PrismaService } from "@/prisma/prisma.service";
import { API } from "@/config/app.constants";

interface StoredResponse<T> {
  value: T;
  storedAt: string;
}

/**
 * Idempotency for money- and session-creating calls.
 *
 * Keys are stored in SystemConfig rather than a dedicated table so the schema
 * stays as documented; the row carries its own expiry and the sweep job removes
 * stale entries. A repeat within the window returns the original response
 * instead of creating a second session or taking a second payment.
 */
@Injectable()
export class IdempotencyService {
  constructor(private readonly prisma: PrismaService) {}

  private storageKey(scope: string, key: string): string {
    return `idem:${scope}:${key}`;
  }

  async get<T>(scope: string, key: string): Promise<T | null> {
    const row = await this.prisma.systemConfig.findUnique({
      where: { key: this.storageKey(scope, key) },
    });
    if (!row) return null;

    const stored = row.value as unknown as StoredResponse<T>;
    const age = (Date.now() - new Date(stored.storedAt).getTime()) / 1000;
    if (age > API.idempotencyTtlSeconds) {
      await this.prisma.systemConfig
        .delete({ where: { key: this.storageKey(scope, key) } })
        .catch(() => undefined);
      return null;
    }
    return stored.value;
  }

  async set<T>(scope: string, key: string, value: T): Promise<void> {
    const payload = { value, storedAt: new Date().toISOString() } as unknown;
    await this.prisma.systemConfig.upsert({
      where: { key: this.storageKey(scope, key) },
      create: { key: this.storageKey(scope, key), value: payload as never },
      update: { value: payload as never },
    });
  }

  /**
   * Runs `work` once per key. A replay returns the stored result and tells the
   * caller so the response can be flagged with `meta.idempotentReplay`.
   */
  async run<T>(
    scope: string,
    key: string,
    work: () => Promise<T>,
  ): Promise<{ value: T; replayed: boolean }> {
    const existing = await this.get<T>(scope, key);
    if (existing !== null) return { value: existing, replayed: true };

    const value = await work();
    await this.set(scope, key, value);
    return { value, replayed: false };
  }
}
