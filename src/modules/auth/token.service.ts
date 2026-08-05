import { Injectable } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import { createHash, randomUUID } from "node:crypto";
import type { User } from "@prisma/client";
import { PrismaService } from "@/prisma/prisma.service";
import { AppException } from "@/common/errors/app.exception";
import type { Env } from "@/config/env.config";

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: string;
  tokenType: "Bearer";
}

interface RefreshRecord {
  userId: string;
  familyId: string;
  sessionId: string;
  usedAt?: string;
  expiresAt: string;
  deviceId?: string;
}

/**
 * Access tokens are short-lived and stateless. Refresh tokens are single-use
 * and stored hashed, grouped into a family.
 *
 * If a refresh token is presented twice, the second use means the token leaked
 * — the whole family is revoked and the user is forced to sign in again. That
 * turns a stolen token into one wasted request instead of persistent access.
 */
@Injectable()
export class TokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  private hash(token: string): string {
    return createHash("sha256").update(token).digest("hex");
  }

  private storageKey(token: string): string {
    return `refresh:${this.hash(token)}`;
  }

  private ttlMs(ttl: string): number {
    const match = ttl.match(/^(\d+)([smhd])$/);
    if (!match) return 30 * 24 * 60 * 60 * 1000;
    const value = Number(match[1]);
    const unit = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2]] ?? 86_400_000;
    return value * unit;
  }

  async issue(user: Pick<User, "id" | "role">, deviceId?: string, familyId?: string): Promise<TokenPair> {
    const sessionId = randomUUID();
    const family = familyId ?? randomUUID();

    const accessToken = await this.jwt.signAsync(
      { sub: user.id, sid: sessionId, role: user.role, did: deviceId },
      {
        secret: this.config.get("JWT_ACCESS_SECRET", { infer: true }),
        expiresIn: this.config.get("ACCESS_TOKEN_TTL", { infer: true }),
      },
    );

    const refreshToken = await this.jwt.signAsync(
      { sub: user.id, sid: sessionId, fam: family, jti: randomUUID() },
      {
        secret: this.config.get("JWT_REFRESH_SECRET", { infer: true }),
        expiresIn: this.config.get("REFRESH_TOKEN_TTL", { infer: true }),
      },
    );

    const expiresAt = new Date(
      Date.now() + this.ttlMs(this.config.get("REFRESH_TOKEN_TTL", { infer: true })),
    );

    const record: RefreshRecord = {
      userId: user.id,
      familyId: family,
      sessionId,
      expiresAt: expiresAt.toISOString(),
      deviceId,
    };

    await this.prisma.systemConfig.create({
      data: { key: this.storageKey(refreshToken), value: record as never },
    });

    return {
      accessToken,
      refreshToken,
      expiresIn: this.config.get("ACCESS_TOKEN_TTL", { infer: true }),
      tokenType: "Bearer",
    };
  }

  async rotate(refreshToken: string): Promise<TokenPair> {
    let claims: { sub: string; fam: string };
    try {
      claims = await this.jwt.verifyAsync(refreshToken, {
        secret: this.config.get("JWT_REFRESH_SECRET", { infer: true }),
      });
    } catch {
      throw new AppException("UNAUTHENTICATED");
    }

    const key = this.storageKey(refreshToken);
    const stored = await this.prisma.systemConfig.findUnique({ where: { key } });
    if (!stored) throw new AppException("UNAUTHENTICATED");

    const record = stored.value as unknown as RefreshRecord;

    // Presented twice — the token leaked. Burn the entire family.
    if (record.usedAt) {
      await this.revokeFamily(record.familyId);
      throw new AppException("TOKEN_REUSED");
    }

    if (new Date(record.expiresAt).getTime() < Date.now()) {
      await this.prisma.systemConfig.delete({ where: { key } }).catch(() => undefined);
      throw new AppException("UNAUTHENTICATED");
    }

    const user = await this.prisma.user.findFirst({
      where: { id: claims.sub, deletedAt: null },
      select: { id: true, role: true },
    });
    if (!user) throw new AppException("UNAUTHENTICATED");

    await this.prisma.systemConfig.update({
      where: { key },
      data: { value: { ...record, usedAt: new Date().toISOString() } as never },
    });

    return this.issue(user, record.deviceId, record.familyId);
  }

  async revoke(refreshToken: string): Promise<void> {
    await this.prisma.systemConfig
      .delete({ where: { key: this.storageKey(refreshToken) } })
      .catch(() => undefined);
  }

  async revokeFamily(familyId: string): Promise<void> {
    const rows = await this.prisma.systemConfig.findMany({
      where: { key: { startsWith: "refresh:" } },
    });
    const doomed = rows
      .filter((r) => (r.value as unknown as RefreshRecord)?.familyId === familyId)
      .map((r) => r.key);
    if (doomed.length > 0) {
      await this.prisma.systemConfig.deleteMany({ where: { key: { in: doomed } } });
    }
  }

  async revokeAllForUser(userId: string): Promise<number> {
    const rows = await this.prisma.systemConfig.findMany({
      where: { key: { startsWith: "refresh:" } },
    });
    const doomed = rows
      .filter((r) => (r.value as unknown as RefreshRecord)?.userId === userId)
      .map((r) => r.key);
    if (doomed.length === 0) return 0;
    const { count } = await this.prisma.systemConfig.deleteMany({
      where: { key: { in: doomed } },
    });
    return count;
  }
}
