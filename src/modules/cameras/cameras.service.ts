import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";

import { PrismaService } from "@/prisma/prisma.service";
import { AppException } from "@/common/errors/app.exception";
import { AuditService } from "@/common/services/audit.service";
import { Paginated } from "@/common/interceptors/response.interceptor";
import { orderBy, skipTake } from "@/common/dto/pagination.dto";
import type { AuthenticatedUser } from "@/common/decorators/auth.decorators";
import type { CameraQueryDto, CreateCameraDto, UpdateCameraDto } from "./dto/camera.dto";

type Ctx = { ip?: string; requestId?: string };

const SORTABLE = ["code", "status", "lastSeenAt", "createdAt"] as const;

const CAMERA_SELECT = {
  id: true,
  streetId: true,
  code: true,
  label: true,
  makeModel: true,
  status: true,
  lastSeenAt: true,
  installedAt: true,
  createdAt: true,
  street: {
    select: {
      id: true,
      name: true,
      ward: { select: { id: true, name: true } },
      zones: { select: { id: true, code: true, name: true } },
    },
  },
} satisfies Prisma.CameraSelect;

/**
 * Cameras on a road.
 *
 * `streamKey` is absent from every read above, and that is not an oversight. It
 * is the handle the gateway answers to, and a client that has it has something
 * it could try to use directly — the whole point of routing playback through a
 * signed, expiring URL is that the client never holds anything reusable.
 */
@Injectable()
export class CamerasService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(query: CameraQueryDto, _user: AuthenticatedUser) {
    const where: Prisma.CameraWhereInput = {
      ...(query.streetId ? { streetId: query.streetId } : {}),
      // A zone's cameras are the ones on its street. Zones are redrawn along a
      // kerb far more often than cameras are moved, so the road is what the
      // hardware belongs to and the zone is a question asked of it.
      ...(query.zoneId ? { street: { zones: { some: { id: query.zoneId } } } } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.q
        ? {
            OR: [
              { code: { contains: query.q, mode: "insensitive" } },
              { label: { contains: query.q, mode: "insensitive" } },
            ],
          }
        : {}),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.camera.findMany({
        where,
        select: CAMERA_SELECT,
        orderBy: orderBy(query.sort, SORTABLE, { code: "asc" }),
        ...skipTake(query),
      }),
      this.prisma.camera.count({ where }),
    ]);

    return new Paginated(rows, query.page, query.pageSize, total);
  }

  async get(id: string) {
    const camera = await this.prisma.camera.findUnique({ where: { id }, select: CAMERA_SELECT });
    if (!camera) throw AppException.notFound("camera");
    return camera;
  }

  /**
   * How many cameras are on each state, for the header of the list screen.
   *
   * Cameras drop constantly, and the useful question on opening this screen is
   * never "how many do we own" but "how many are dark right now".
   */
  async health() {
    const [byStatus, total, neverSeen] = await Promise.all([
      this.prisma.camera.groupBy({ by: ["status"], _count: { _all: true } }),
      this.prisma.camera.count(),
      this.prisma.camera.count({ where: { lastSeenAt: null } }),
    ]);

    return {
      total,
      neverSeen,
      byStatus: byStatus.map((s) => ({ status: s.status, count: s._count._all })),
    };
  }

  /**
   * Where to play this camera from.
   *
   * There is no streaming gateway yet, so this answers honestly rather than
   * failing. A screen that is told `available: false` with a reason can say
   * which piece is missing; a 404 or a dead player leaves somebody checking
   * cables for a service that was never deployed.
   *
   * When a gateway exists this returns a short-lived signed URL and an expiry,
   * and nothing above this line has to change.
   */
  async playback(id: string, user: AuthenticatedUser, ctx: Ctx) {
    const camera = await this.get(id);

    // Watching a street is worth recording even when nothing plays. "Who
    // looked at which camera, and when" is the first question any inquiry
    // asks, and it cannot be answered retrospectively.
    await this.audit.record({
      actor: user,
      action: "CAMERA_VIEW",
      entity: "Camera",
      entityId: camera.id,
      after: { code: camera.code, street: camera.street.name },
      ...ctx,
    });

    return {
      cameraId: camera.id,
      available: false as const,
      reason: "NO_GATEWAY" as const,
      detail:
        "No streaming gateway is configured. Cameras are recorded here and the screens are " +
        "built, but nothing is transcoding RTSP to a format a browser can play yet.",
      // Shape the player already expects, so wiring a gateway changes this
      // service and nothing on the client.
      playbackUrl: null as string | null,
      protocol: null as "HLS" | "WEBRTC" | null,
      expiresAt: null as string | null,
    };
  }

  async create(dto: CreateCameraDto, user: AuthenticatedUser, ctx: Ctx) {
    const street = await this.prisma.street.findUnique({
      where: { id: dto.streetId },
      select: { id: true, name: true },
    });
    if (!street) {
      throw new AppException("VALIDATION_FAILED", [
        { field: "streetId", issue: "no such road" },
      ]);
    }

    const clash = await this.prisma.camera.findUnique({ where: { code: dto.code } });
    if (clash) {
      throw new AppException("DUPLICATE_RESOURCE", [
        { field: "code", issue: "a camera with this code already exists" },
      ]);
    }

    const camera = await this.prisma.camera.create({
      data: { ...dto },
      select: CAMERA_SELECT,
    });

    await this.audit.record({
      actor: user,
      action: "CAMERA_CREATE",
      entity: "Camera",
      entityId: camera.id,
      after: { code: camera.code, label: camera.label, street: street.name },
      ...ctx,
    });

    return camera;
  }

  async update(id: string, dto: UpdateCameraDto, user: AuthenticatedUser, ctx: Ctx) {
    const before = await this.get(id);

    if (dto.code && dto.code !== before.code) {
      const clash = await this.prisma.camera.findUnique({ where: { code: dto.code } });
      if (clash) {
        throw new AppException("DUPLICATE_RESOURCE", [
          { field: "code", issue: "a camera with this code already exists" },
        ]);
      }
    }

    const camera = await this.prisma.camera.update({
      where: { id },
      data: { ...dto },
      select: CAMERA_SELECT,
    });

    await this.audit.record({
      actor: user,
      action: "CAMERA_UPDATE",
      entity: "Camera",
      entityId: id,
      before: { code: before.code, label: before.label, status: before.status },
      after: { code: camera.code, label: camera.label, status: camera.status },
      ...ctx,
    });

    return camera;
  }
}
