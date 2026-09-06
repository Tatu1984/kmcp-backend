import { Injectable, Logger } from "@nestjs/common";
import { CameraStatus, Prisma } from "@prisma/client";
import { ConfigService } from "@nestjs/config";

import { PrismaService } from "@/prisma/prisma.service";
import { AppException } from "@/common/errors/app.exception";
import { AuditService } from "@/common/services/audit.service";
import { Paginated } from "@/common/interceptors/response.interceptor";
import { orderBy, skipTake } from "@/common/dto/pagination.dto";
import { decryptSecret, encryptSecret } from "@/common/crypto/secret-box";
import type { Env } from "@/config/env.config";
import type { AuthenticatedUser } from "@/common/decorators/auth.decorators";
import type { CameraQueryDto, CreateCameraDto, UpdateCameraDto } from "./dto/camera.dto";
import { StreamGatewayService } from "./streaming/stream-gateway.service";
import { credentialFreeRtspUrl, credentialedRtspUrl } from "./streaming/rtsp-url";
import { probeRtsp } from "./streaming/probe";

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
  // Facts about the device, which the list screen shows and nobody can use to
  // reach it: what it can do, whether it is in service, and what the last probe
  // saw. Note what is not here — `rtspUrl`, `usernameEnc`, `passwordEnc`.
  coverageSlots: true,
  hasIR: true,
  hasPTZ: true,
  isActive: true,
  resolution: true,
  fps: true,
  probedAt: true,
  probeError: true,
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
  private readonly logger = new Logger(CamerasService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly gateway: StreamGatewayService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /**
   * The path this camera answers to on the gateway.
   *
   * Derived from the code when nothing was given, because a gateway path and a
   * camera code are the same idea twice and nobody wants to invent a second
   * name for the same box. Lower-cased and stripped because MediaMTX path names
   * are URL segments.
   */
  private pathFor(camera: { code: string; streamKey?: string | null }): string {
    return camera.streamKey ?? camera.code.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  }

  private get encryptionKey(): string | undefined {
    return this.config.get("ENCRYPTION_KEY", { infer: true });
  }

  /**
   * The stored credentials, decrypted, for handing to the gateway.
   *
   * Returns nulls rather than throwing when the column cannot be read — a
   * rotated key should degrade to "this stream needs its password again", which
   * the gateway will report as an authentication failure, rather than taking
   * out the whole camera screen.
   */
  private credentials(camera: { usernameEnc: string | null; passwordEnc: string | null }): {
    username: string | null;
    password: string | null;
  } {
    const read = (value: string | null): string | null => {
      if (!value) return null;
      try {
        return decryptSecret(value, this.encryptionKey);
      } catch {
        this.logger.warn("Stored camera credential could not be decrypted; treating as unset");
        return null;
      }
    };
    return { username: read(camera.usernameEnc), password: read(camera.passwordEnc) };
  }

  /**
   * Splits what a write said about credentials into columns.
   *
   * Three cases, and they have to stay distinguishable: say nothing and what is
   * stored is kept; send a value and it replaces what is stored; send
   * `clearCredentials` and both columns are emptied. A blank string is the
   * second of those and not the third, which is why the check is on
   * `undefined`.
   */
  private credentialColumns(dto: {
    username?: string;
    password?: string;
    clearCredentials?: boolean;
  }): { usernameEnc?: string | null; passwordEnc?: string | null } {
    if (dto.clearCredentials) return { usernameEnc: null, passwordEnc: null };

    const columns: { usernameEnc?: string | null; passwordEnc?: string | null } = {};
    if (dto.username !== undefined) {
      columns.usernameEnc = dto.username ? encryptSecret(dto.username, this.encryptionKey) : null;
    }
    if (dto.password !== undefined) {
      columns.passwordEnc = dto.password ? encryptSecret(dto.password, this.encryptionKey) : null;
    }
    return columns;
  }

  /**
   * Point the gateway at this camera, or take it down.
   *
   * Best effort on purpose. A media server that is down must not stop an
   * engineer registering the camera they have just bolted to a pole — the row
   * is the record, the gateway is a cache of it, and `playback` re-registers
   * anything missing the next time somebody asks to watch.
   */
  private async syncGateway(cameraId: string): Promise<void> {
    if (!this.gateway.configured) return;

    const camera = await this.prisma.camera.findUnique({
      where: { id: cameraId },
      select: {
        code: true,
        streamKey: true,
        rtspUrl: true,
        isActive: true,
        usernameEnc: true,
        passwordEnc: true,
      },
    });
    if (!camera) return;

    const path = this.pathFor(camera);

    // Out of service, or nothing to pull from: the gateway should not be
    // holding a path for it.
    if (!camera.rtspUrl || !camera.isActive) {
      await this.gateway.unregister(path);
      return;
    }

    try {
      await this.gateway.register(path, { rtspUrl: camera.rtspUrl, ...this.credentials(camera) });
    } catch (error) {
      this.logger.warn(
        `Camera ${camera.code} was saved but the gateway would not take it: ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  }

  async list(query: CameraQueryDto, _user: AuthenticatedUser) {
    const where: Prisma.CameraWhereInput = {
      ...(query.streetId ? { streetId: query.streetId } : {}),
      // A zone's cameras are the ones on its street. Zones are redrawn along a
      // kerb far more often than cameras are moved, so the road is what the
      // hardware belongs to and the zone is a question asked of it.
      ...(query.zoneId ? { street: { zones: { some: { id: query.zoneId } } } } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.isActive === undefined ? {} : { isActive: query.isActive }),
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

    const unavailable = (reason: string, detail: string) => ({
      cameraId: camera.id,
      available: false as const,
      reason,
      detail,
      hlsUrl: null as string | null,
      webrtcUrl: null as string | null,
      path: null as string | null,
      ready: false,
    });

    const source = await this.prisma.camera.findUnique({
      where: { id },
      select: { code: true, streamKey: true, rtspUrl: true, isActive: true },
    });

    if (!source?.rtspUrl) {
      return unavailable(
        "NO_SOURCE",
        "This camera has no stream address recorded, so there is nothing for the gateway to " +
          "pull. Edit the camera and give it an RTSP address.",
      );
    }

    if (!source.isActive) {
      return unavailable(
        "OUT_OF_SERVICE",
        "This camera has been taken out of service. Put it back in service to watch it again.",
      );
    }

    if (!this.gateway.configured) {
      return unavailable(
        "NO_GATEWAY",
        "No streaming gateway is configured. The camera is registered and the screens are " +
          "built, but nothing is turning RTSP into a format a browser can play. Set " +
          "MEDIAMTX_CONTROL_URL and the two public bases.",
      );
    }

    const path = this.pathFor(source);
    const urls = this.gateway.playbackUrls(path);

    if (!urls) {
      return unavailable(
        "NO_GATEWAY",
        "A gateway control URL is set but neither public base is, so there is no address a " +
          "browser could open. Set MEDIAMTX_HLS_BASE and MEDIAMTX_WEBRTC_BASE.",
      );
    }

    /**
     * Registered on the way past, every time.
     *
     * The gateway holds its paths in memory, so a restart loses them all; a
     * camera edited while it was down never reached it in the first place.
     * Registration is idempotent and the pull is on demand, so doing it here
     * costs one control-API call and removes an entire class of "worked
     * yesterday" from the screen.
     */
    await this.syncGateway(camera.id);
    const health = await this.gateway.health(path);

    return {
      cameraId: camera.id,
      available: true as const,
      reason: null,
      detail: null,
      path,
      // Neither URL carries a credential — that is the whole point of the
      // gateway, and the reason these can be handed to a browser at all.
      hlsUrl: urls.hlsUrl,
      webrtcUrl: urls.webrtcUrl,
      /**
       * Whether the gateway has the picture right now.
       *
       * False is normal rather than wrong: the pull is on demand, so a stream
       * nobody has watched for a while is not connected until the player asks.
       * The player uses this to choose its message while it waits.
       */
      ready: health?.ready ?? false,
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

    // Everything except the two credential fields, which are not columns —
    // they are inputs to columns, and go through `credentialColumns`.
    const { username: _u, password: _p, ...fields } = dto;

    const camera = await this.prisma.camera.create({
      data: { ...fields, ...this.credentialColumns(dto) },
      select: CAMERA_SELECT,
    });

    await this.audit.record({
      actor: user,
      action: "CAMERA_CREATE",
      entity: "Camera",
      entityId: camera.id,
      // The address is recorded; the credentials are not, here or anywhere.
      // An audit trail that carried them would be a second copy of the secret
      // in a table read under a different permission.
      after: {
        code: camera.code,
        label: camera.label,
        street: street.name,
        source: credentialFreeRtspUrl(dto.rtspUrl ?? null),
        credentials: dto.username ? "set" : "none",
      },
      ...ctx,
    });

    await this.syncGateway(camera.id);

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

    const { username: _u, password: _p, clearCredentials: _c, ...fields } = dto;

    const camera = await this.prisma.camera.update({
      where: { id },
      data: { ...fields, ...this.credentialColumns(dto) },
      select: CAMERA_SELECT,
    });

    await this.audit.record({
      actor: user,
      action: "CAMERA_UPDATE",
      entity: "Camera",
      entityId: id,
      before: {
        code: before.code,
        label: before.label,
        status: before.status,
        isActive: before.isActive,
      },
      after: {
        code: camera.code,
        label: camera.label,
        status: camera.status,
        isActive: camera.isActive,
        ...(dto.rtspUrl ? { source: credentialFreeRtspUrl(dto.rtspUrl) } : {}),
        ...(dto.clearCredentials
          ? { credentials: "cleared" }
          : dto.username !== undefined || dto.password !== undefined
            ? { credentials: "replaced" }
            : {}),
      },
      ...ctx,
    });

    // The source, the credentials or the in-service flag may all have moved.
    await this.syncGateway(id);

    return camera;
  }

  /**
   * What a camera is connected to, for the person editing it.
   *
   * A separate route rather than fields on `get`, because this answers a
   * different question under a different permission: the list screen shows
   * everyone with `camera.view` where the cameras are and whether they are
   * working, and this shows the handful of people with `camera.manage` how one
   * is plumbed in, so that an edit form can be filled in without them having to
   * remember.
   *
   * Even here the password never comes back — `hasCredentials` is the whole of
   * what is said about it. The edit form leaves the field blank and blank means
   * "keep", so there is nothing a form needs the actual value for. The username
   * is not returned either: half a credential is still half a credential, and
   * an operator changing one will type both.
   */
  async connection(id: string) {
    const camera = await this.prisma.camera.findUnique({
      where: { id },
      select: {
        id: true,
        code: true,
        streamKey: true,
        rtspUrl: true,
        onvifUrl: true,
        usernameEnc: true,
        passwordEnc: true,
        coverageSlots: true,
        hasIR: true,
        hasPTZ: true,
        isActive: true,
        makeModel: true,
        installedAt: true,
        label: true,
        streetId: true,
      },
    });
    if (!camera) throw AppException.notFound("camera");

    const { usernameEnc, passwordEnc, ...rest } = camera;
    return {
      ...rest,
      // Stripped rather than redacted: if somebody registered the camera with a
      // credentialed URL, this is where that password would otherwise leak.
      rtspUrl: credentialFreeRtspUrl(camera.rtspUrl),
      hasCredentials: Boolean(usernameEnc || passwordEnc),
      path: this.pathFor(camera),
    };
  }

  /**
   * Ask the camera itself, and write down what it said.
   *
   * This is the only operation in the module that produces a fact rather than
   * repeating one. It is also the only one that can take eight seconds, which
   * is why it is a button somebody presses rather than something the list does
   * for forty cameras on load.
   *
   * The result is stored: status, resolution, frame rate and — when it fails —
   * the reason, in ffprobe's own words. A screen that says "offline" and can
   * show "401 Unauthorized" underneath has told an engineer to check the
   * password rather than the pole.
   */
  async probe(id: string, user: AuthenticatedUser, ctx: Ctx) {
    const camera = await this.prisma.camera.findUnique({
      where: { id },
      select: { id: true, code: true, rtspUrl: true, usernameEnc: true, passwordEnc: true },
    });
    if (!camera) throw AppException.notFound("camera");

    if (!camera.rtspUrl) {
      throw new AppException(
        "VALIDATION_FAILED",
        [{ field: "rtspUrl", issue: "this camera has no stream address" }],
        `${camera.code} has no RTSP address recorded, so there is nothing to test. Edit the ` +
          "camera and give it one.",
      );
    }

    const result = await probeRtsp(
      credentialedRtspUrl({ rtspUrl: camera.rtspUrl, ...this.credentials(camera) }),
    );

    /**
     * A failed probe does not mark a camera OFFLINE if somebody has deliberately
     * parked it in MAINTENANCE or DECOMMISSIONED. Those are statements about
     * intent, and a machine that cannot reach a camera has no business
     * overruling them.
     */
    const existing = await this.prisma.camera.findUnique({
      where: { id },
      select: { status: true },
    });
    const manual =
      existing?.status === CameraStatus.MAINTENANCE ||
      existing?.status === CameraStatus.DECOMMISSIONED;

    const updated = await this.prisma.camera.update({
      where: { id },
      data: {
        ...(manual
          ? {}
          : { status: result.reachable ? CameraStatus.ONLINE : CameraStatus.OFFLINE }),
        ...(result.reachable ? { lastSeenAt: new Date() } : {}),
        probedAt: new Date(),
        probeError: result.reachable ? null : (result.error ?? "unreachable"),
        resolution: result.resolution ?? null,
        fps: result.fps ?? null,
      },
      select: CAMERA_SELECT,
    });

    await this.audit.record({
      actor: user,
      action: "CAMERA_PROBE",
      entity: "Camera",
      entityId: id,
      after: {
        code: camera.code,
        reachable: result.reachable,
        resolution: result.resolution,
        codec: result.codec,
        error: result.error,
      },
      ...ctx,
    });

    return {
      camera: updated,
      reachable: result.reachable,
      resolution: result.resolution ?? null,
      fps: result.fps ?? null,
      codec: result.codec ?? null,
      error: result.error ?? null,
      /** True when the probe's verdict was not applied because a person had set the status. */
      statusHeld: manual,
    };
  }

  /**
   * Remove a camera.
   *
   * Deliberately a real delete rather than a flag. `isActive` already covers
   * the case this is usually confused with — a camera that is off the network
   * but still on the pole — and a row nobody can see is worse than a row that
   * says "out of service" with its history intact. What this is for is the
   * camera that was never there: a duplicate, a typo, a plan that changed.
   *
   * The audit entry outlives the row, which is the point of writing it here.
   */
  async remove(id: string, user: AuthenticatedUser, ctx: Ctx) {
    const camera = await this.prisma.camera.findUnique({
      where: { id },
      select: { id: true, code: true, label: true, streamKey: true, street: { select: { name: true } } },
    });
    if (!camera) throw AppException.notFound("camera");

    await this.gateway.unregister(this.pathFor(camera));
    await this.prisma.camera.delete({ where: { id } });

    await this.audit.record({
      actor: user,
      action: "CAMERA_DELETE",
      entity: "Camera",
      entityId: id,
      before: { code: camera.code, label: camera.label, street: camera.street.name },
      ...ctx,
    });

    return { id, deleted: true as const };
  }
}
