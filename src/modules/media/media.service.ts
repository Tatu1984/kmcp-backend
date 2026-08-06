import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { MediaPurpose, Prisma } from "@prisma/client";
import { GetObjectCommand, PutObjectCommand, S3Client, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID } from "node:crypto";

import { PrismaService } from "@/prisma/prisma.service";
import { AppException } from "@/common/errors/app.exception";
import { AuditService } from "@/common/services/audit.service";
import type { Env } from "@/config/env.config";
import type { AuthenticatedUser } from "@/common/decorators/auth.decorators";
import type { ConfirmUploadDto, RequestUploadDto } from "./dto/media.dto";

type Ctx = { ip?: string; requestId?: string };

/**
 * Evidence and document storage.
 *
 * Files never pass through this API. The client asks for a presigned PUT,
 * uploads straight to object storage, then confirms — so an attendant on a
 * patchy 3G connection at the kerb is not fighting a serverless function with a
 * request timeout, and a 4 MB photograph is not buffered into a Lambda.
 *
 * Keys are server-generated. A client that chose its own could overwrite
 * somebody else's evidence by naming it.
 */
@Injectable()
export class MediaService {
  private readonly logger = new Logger(MediaService.name);
  private client: S3Client | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
    private readonly audit: AuditService,
  ) {}

  /** Built lazily so the API still boots when storage is not configured yet. */
  private s3(): S3Client {
    if (this.client) return this.client;

    const endpoint = this.config.get("S3_ENDPOINT", { infer: true });
    const accessKeyId = this.config.get("S3_ACCESS_KEY_ID", { infer: true });
    const secretAccessKey = this.config.get("S3_SECRET_ACCESS_KEY", { infer: true });

    if (!endpoint || !accessKeyId || !secretAccessKey) {
      throw new AppException(
        "SERVICE_UNAVAILABLE",
        [{ field: "storage", issue: "S3_ENDPOINT, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY are not set" }],
        "File storage is not configured on this deployment.",
      );
    }

    this.client = new S3Client({
      region: this.config.get("S3_REGION", { infer: true }),
      endpoint,
      credentials: { accessKeyId, secretAccessKey },
      // Required by R2, MinIO and most S3-compatible providers.
      forcePathStyle: true,
    });
    return this.client;
  }

  private get bucket(): string {
    return this.config.get("S3_BUCKET", { infer: true });
  }

  private get ttl(): number {
    return this.config.get("MEDIA_SIGNED_URL_TTL", { infer: true });
  }

  /**
   * Object keys are grouped by purpose and date so a bucket lifecycle rule can
   * expire report exports without touching parking evidence, which must be kept.
   */
  private buildKey(purpose: MediaPurpose, mimeType: string): string {
    const now = new Date();
    const yyyy = now.getUTCFullYear();
    const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(now.getUTCDate()).padStart(2, "0");
    const extension = mimeType.split("/")[1]?.replace(/[^a-z0-9]/gi, "") ?? "bin";
    return `${purpose.toLowerCase()}/${yyyy}/${mm}/${dd}/${randomUUID()}.${extension}`;
  }

  async requestUpload(dto: RequestUploadDto, user: AuthenticatedUser) {
    const key = this.buildKey(dto.purpose, dto.mimeType);

    const uploadUrl = await getSignedUrl(
      this.s3(),
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: dto.mimeType,
        ContentLength: dto.sizeBytes,
      }),
      { expiresIn: this.ttl },
    );

    // The row is written on confirm, not here: a presigned URL that is never
    // used would otherwise leave a Media record pointing at nothing.
    return {
      uploadUrl,
      key,
      bucket: this.bucket,
      expiresInSeconds: this.ttl,
      method: "PUT" as const,
      headers: { "content-type": dto.mimeType },
      uploadedBy: user.id,
    };
  }

  async confirmUpload(dto: ConfirmUploadDto, user: AuthenticatedUser, ctx: Ctx) {
    const existing = await this.prisma.media.findUnique({ where: { key: dto.key } });
    if (existing) return existing;

    const media = await this.prisma.media.create({
      data: {
        key: dto.key,
        bucket: this.bucket,
        mimeType: dto.mimeType,
        sizeBytes: dto.sizeBytes,
        sha256: dto.sha256,
        purpose: dto.purpose,
        capturedAt: dto.capturedAt,
        lat: dto.lat,
        lng: dto.lng,
        uploadedById: user.id,
        // Parking evidence is what a disputed fare is decided on. Once recorded
        // it must never be replaced, only superseded by a new record.
        isImmutable:
          dto.purpose === MediaPurpose.SESSION_EVIDENCE_START ||
          dto.purpose === MediaPurpose.SESSION_EVIDENCE_END,
      },
    });

    await this.audit.record({
      actor: user,
      action: "MEDIA_UPLOAD",
      entity: "Media",
      entityId: media.id,
      after: { purpose: media.purpose, sizeBytes: media.sizeBytes, mimeType: media.mimeType },
      ...ctx,
    });

    return media;
  }

  /** A short-lived read URL. Nothing in the bucket is publicly readable. */
  async signedUrl(id: string) {
    const media = await this.prisma.media.findUnique({ where: { id } });
    if (!media) throw AppException.notFound("media");

    const url = await getSignedUrl(
      this.s3(),
      new GetObjectCommand({ Bucket: media.bucket, Key: media.key }),
      { expiresIn: this.ttl },
    );

    return {
      id: media.id,
      url,
      mimeType: media.mimeType,
      sizeBytes: media.sizeBytes,
      purpose: media.purpose,
      capturedAt: media.capturedAt,
      expiresInSeconds: this.ttl,
    };
  }

  /** Signs a batch in one call — a KYC panel needs six at once, not six calls. */
  async signedUrls(ids: string[]) {
    const rows = await this.prisma.media.findMany({ where: { id: { in: ids } } });
    return Promise.all(
      rows.map(async (media) => ({
        id: media.id,
        url: await getSignedUrl(
          this.s3(),
          new GetObjectCommand({ Bucket: media.bucket, Key: media.key }),
          { expiresIn: this.ttl },
        ),
        mimeType: media.mimeType,
        purpose: media.purpose,
      })),
    );
  }

  async list(query: { purpose?: MediaPurpose; page: number; pageSize: number }) {
    const where: Prisma.MediaWhereInput = query.purpose ? { purpose: query.purpose } : {};
    const [items, total] = await this.prisma.$transaction([
      this.prisma.media.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.media.count({ where }),
    ]);
    return { items, total };
  }

  async remove(id: string, user: AuthenticatedUser, ctx: Ctx) {
    const media = await this.prisma.media.findUnique({ where: { id } });
    if (!media) throw AppException.notFound("media");

    if (media.isImmutable) {
      throw AppException.forbidden(
        "This is parking evidence. It cannot be deleted — a disputed fare is settled on it.",
      );
    }

    const attached = await this.prisma.vendorDocument.count({ where: { mediaId: id } });
    if (attached > 0) {
      throw new AppException(
        "FORBIDDEN",
        [{ field: "id", issue: "still attached to a vendor document" }],
        "Detach this file from the vendor's documents before deleting it.",
      );
    }

    try {
      await this.s3().send(new DeleteObjectCommand({ Bucket: media.bucket, Key: media.key }));
    } catch (error) {
      // The row is the source of truth. A key left behind in the bucket is
      // rubbish to collect later, not a reason to fail the request.
      this.logger.warn(`Could not delete ${media.key} from storage: ${String(error)}`);
    }

    await this.prisma.media.delete({ where: { id } });

    await this.audit.record({
      actor: user,
      action: "MEDIA_DELETE",
      entity: "Media",
      entityId: id,
      before: { key: media.key, purpose: media.purpose },
      ...ctx,
    });

    return { deleted: true, id };
  }
}
