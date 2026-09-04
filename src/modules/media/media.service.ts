import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { MediaPurpose, Prisma } from "@prisma/client";
import { GetObjectCommand, PutObjectCommand, S3Client, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createHash, randomUUID } from "node:crypto";

import { PrismaService } from "@/prisma/prisma.service";
import { AppException } from "@/common/errors/app.exception";
import { AuditService } from "@/common/services/audit.service";
import type { Env } from "@/config/env.config";
import type { AuthenticatedUser } from "@/common/decorators/auth.decorators";
import type { ConfirmUploadDto, RequestUploadDto } from "./dto/media.dto";
import { MediaAccessService } from "./media-access.service";

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
 *
 * Reads are authorised per file. Uploading is open to any authenticated
 * account, because photographing a plate and supplying a KYC document are both
 * ordinary work — but a signed read URL is a bearer credential for the bytes,
 * so who may be issued one is decided by MediaAccessService before anything is
 * signed.
 */
@Injectable()
export class MediaService {
  private readonly logger = new Logger(MediaService.name);
  private client: S3Client | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
    private readonly audit: AuditService,
    private readonly access: MediaAccessService,
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

  /**
   * The key a generated document lives at.
   *
   * Unlike `buildKey` there is no random component: the address *is* the
   * fingerprint of the record the document renders, so asking for the same
   * receipt twice asks for the same object. `anchor` is the record's own date
   * rather than today's, which keeps the whole key deterministic while still
   * partitioning by date for the bucket lifecycle rules.
   */
  documentKey(purpose: MediaPurpose, anchor: Date, digest: string, extension = "pdf"): string {
    const yyyy = anchor.getUTCFullYear();
    const mm = String(anchor.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(anchor.getUTCDate()).padStart(2, "0");
    return `${purpose.toLowerCase()}/${yyyy}/${mm}/${dd}/${digest}.${extension}`;
  }

  /** The stored file at a key, or null. How a regeneration finds its predecessor. */
  findByKey(key: string) {
    return this.prisma.media.findUnique({ where: { key } });
  }

  /**
   * Stores bytes this API produced itself.
   *
   * The two-step presigned flow above exists so a handset's photograph never
   * travels through a serverless function. A rendered PDF is the opposite case:
   * it is already in this process's memory, it is tens of kilobytes, and there
   * is no client to hand a presigned URL to. So it goes straight to the bucket.
   *
   * Idempotent on the key. A concurrent request that rendered the same content
   * gets the row the first one wrote rather than a unique-constraint failure —
   * the bytes are identical by construction, so whichever PUT lands last is the
   * same object either way.
   */
  async storeGenerated(input: {
    key: string;
    body: Uint8Array;
    mimeType: string;
    purpose: MediaPurpose;
    uploadedById: string;
    /** True for documents that must never be replaced once issued. */
    immutable?: boolean;
  }) {
    const body = Buffer.from(input.body);
    const sha256 = createHash("sha256").update(body).digest("hex");

    await this.s3().send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: input.key,
        Body: body,
        ContentType: input.mimeType,
      }),
    );

    try {
      return await this.prisma.media.create({
        data: {
          key: input.key,
          bucket: this.bucket,
          mimeType: input.mimeType,
          sizeBytes: body.byteLength,
          sha256,
          purpose: input.purpose,
          uploadedById: input.uploadedById,
          isImmutable: input.immutable ?? false,
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const existing = await this.prisma.media.findUnique({ where: { key: input.key } });
        if (existing) return existing;
      }
      throw error;
    }
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
  async signedUrl(id: string, user: AuthenticatedUser) {
    const media = await this.prisma.media.findUnique({ where: { id } });
    if (!media) throw AppException.notFound("media");

    // Before anything is signed. A URL that has been minted cannot be recalled,
    // so the refusal has to happen ahead of it rather than around it.
    await this.access.assertMayRead([media], user);

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

  /**
   * Signs a batch in one call — a KYC panel needs six at once, not six calls.
   *
   * Every id in the batch is authorised individually, and one refusal fails the
   * whole request. Anything laxer would make this route the way around the
   * single-item check rather than a saving of five round trips.
   */
  async signedUrls(ids: string[], user: AuthenticatedUser) {
    const rows = await this.prisma.media.findMany({ where: { id: { in: ids } } });
    await this.access.assertMayRead(rows, user);

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

  /**
   * Deletes objects from the bucket without asking who is asking.
   *
   * The only caller is the retention sweep, which has already decided that
   * these files have outlived the period the authority published for them. It
   * bypasses `remove` below deliberately: that method refuses anything marked
   * immutable, which every evidence photograph is. Immutability means nobody
   * edits or replaces the file, not that it is kept forever — expiry on a
   * published schedule is the one thing entitled to end its life.
   *
   * Best-effort, and it must stay that way. A deployment with no storage
   * configured, or a bucket having a bad afternoon, should not stop the
   * database rows being purged: an orphaned object is rubbish to collect, while
   * a row that survives its retention period is a broken promise.
   */
  async discardObjects(files: { key: string; bucket: string }[]): Promise<number> {
    let deleted = 0;
    for (const file of files) {
      try {
        await this.s3().send(new DeleteObjectCommand({ Bucket: file.bucket, Key: file.key }));
        deleted++;
      } catch (error) {
        this.logger.warn(`Retention could not delete ${file.key} from storage: ${String(error)}`);
      }
    }
    return deleted;
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
