import { Injectable, Logger } from "@nestjs/common";

import { PrismaService } from "@/prisma/prisma.service";
import { AppException } from "@/common/errors/app.exception";
import type { CreateCameraDto } from "./dto/camera.dto";
import { newIngestKey, newIngestToken, hashToken } from "./ingest-token";
import { liveness, livenessMany, playbackUrl, type CameraStatus } from "./status";
import { getMediaStore, safeName } from "./media/store";

/** One camera as returned to an administrator (never carries the token hash). */
export interface CameraView {
  id: string;
  name: string;
  group: string | null;
  ingestKey: string;
  hlsUrl: string;
  status: CameraStatus;
  available: boolean;
  checkedAt: string;
  createdAt: string;
}

/** The one-time secrets shown when a camera is created or its token rotated. */
export interface EdgeAgentConfig {
  ingestUrl: string;
  ingestToken: string;
  publishUrl: string;
  cameraId: string;
}

@Injectable()
export class CamerasService {
  private readonly logger = new Logger(CamerasService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Every camera in the system, with live status read from storage. Org-wide. */
  async list(base: string): Promise<CameraView[]> {
    const cams = await this.prisma.camera.findMany({ orderBy: { createdAt: "asc" } });
    const live = await livenessMany(cams.map((c) => c.ingestKey));
    return cams.map((c) => {
      const l = live.get(c.ingestKey) ?? { status: "OFFLINE" as CameraStatus, available: false };
      return {
        id: c.id,
        name: c.name,
        group: c.grp,
        ingestKey: c.ingestKey,
        hlsUrl: playbackUrl(c.ingestKey, base),
        status: l.status,
        available: l.available,
        checkedAt: new Date().toISOString(),
        createdAt: c.createdAt.toISOString(),
      };
    });
  }

  /**
   * Register a camera. The ingest token is generated here, hashed for storage,
   * and returned exactly once in `edgeAgent` — it can never be shown again.
   */
  async create(
    dto: CreateCameraDto,
    base: string,
  ): Promise<{ camera: Omit<CameraView, "hlsUrl" | "status" | "available" | "checkedAt">; edgeAgent: EdgeAgentConfig }> {
    const ingestKey = newIngestKey();
    const ingestToken = newIngestToken();
    const cam = await this.prisma.camera.create({
      data: {
        name: dto.name,
        grp: dto.group ?? null,
        ingestKey,
        ingestTokenHash: hashToken(ingestToken),
      },
    });

    return {
      camera: {
        id: cam.id,
        name: cam.name,
        group: cam.grp,
        ingestKey: cam.ingestKey,
        createdAt: cam.createdAt.toISOString(),
      },
      edgeAgent: {
        ingestUrl: base, // Edge Agent → Ingest URL
        ingestToken, // Edge Agent → Token (shown once!)
        publishUrl: playbackUrl(cam.ingestKey, base),
        cameraId: cam.ingestKey,
      },
    };
  }

  /** Rotate a camera's ingest token, revoking the old one. Returns the new token once. */
  async rotateToken(id: string, base: string): Promise<EdgeAgentConfig> {
    const cam = await this.prisma.camera.findUnique({ where: { id } });
    if (!cam) throw AppException.notFound("camera");
    const ingestToken = newIngestToken();
    await this.prisma.camera.update({
      where: { id },
      data: { ingestTokenHash: hashToken(ingestToken) },
    });
    return {
      ingestUrl: base,
      ingestToken,
      publishUrl: playbackUrl(cam.ingestKey, base),
      cameraId: cam.ingestKey,
    };
  }

  /** Delete a camera and best-effort purge its playlist + segments from storage. */
  async remove(id: string): Promise<{ deleted: true; id: string }> {
    const cam = await this.prisma.camera.findUnique({ where: { id } });
    if (!cam) throw AppException.notFound("camera");

    await this.prisma.camera.delete({ where: { id } });

    // Best-effort: a leftover object in the bucket is rubbish to collect later,
    // not a reason to fail the delete.
    try {
      const store = await getMediaStore();
      await store.delete(cam.ingestKey, "index.m3u8");
    } catch (e) {
      this.logger.warn(`Could not purge storage for camera ${id}: ${String(e)}`);
    }

    return { deleted: true, id };
  }

  // ── ingest path (called by the public ingest controller) ──────────────────

  /** Find a camera by ingest key and verify the presented bearer token. */
  async authenticateIngest(ingestKey: string, token: string | null) {
    if (!token) return null;
    const cam = await this.prisma.camera.findUnique({ where: { ingestKey } });
    if (!cam) return null;
    const { verifyToken } = await import("./ingest-token");
    return verifyToken(token, cam.ingestTokenHash) ? cam : null;
  }

  /** True if a camera with this ingest key exists (for admin-gated playback). */
  async ingestKeyExists(ingestKey: string): Promise<boolean> {
    const cam = await this.prisma.camera.findUnique({
      where: { ingestKey },
      select: { id: true },
    });
    return !!cam;
  }

  /** Store one uploaded HLS file. `file` is validated by the caller too. */
  async putMedia(ingestKey: string, file: string, body: Uint8Array) {
    const name = safeName(file);
    if (!name) return { ok: false, error: "bad file name" };
    const store = await getMediaStore();
    return store.put(ingestKey, name, body);
  }

  async deleteMedia(ingestKey: string, file: string) {
    const name = safeName(file);
    if (!name) return { ok: false, error: "bad file name" };
    const store = await getMediaStore();
    return store.delete(ingestKey, name);
  }

  async getMedia(ingestKey: string, file: string) {
    const name = safeName(file);
    if (!name) return { ok: false as const, error: "bad file name" };
    const store = await getMediaStore();
    return store.get(ingestKey, name);
  }

  /** Liveness of a single camera (used where a screen wants one). */
  liveness(ingestKey: string) {
    return liveness(ingestKey);
  }
}
