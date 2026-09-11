// Cloudflare R2 media store (S3-compatible API via @aws-sdk/client-s3).
//
// R2 is the scale target: durable, effectively unlimited, ZERO egress fees, and
// frontable by a CDN. It works on Vercel because the bytes live in R2, not on
// Vercel's ephemeral FS. Ported from the live-feed portal and wired to KMCP's
// existing S3_* configuration (the same variables the media module uses), so
// there is no separate R2 credential set.
//
// Objects are keyed `<prefix>/<streamKey>/<file>`. Segments are written with a
// long immutable cache header so a CDN in front of R2 serves the fan-out and the
// origin stays cool; playlists are written no-cache.
//
// Env (see .env.example / env.config.ts):
//   MEDIA_BACKEND=r2
//   S3_ENDPOINT            S3-compatible endpoint (R2: https://<acct>.r2.cloudflarestorage.com)
//   S3_REGION              default "auto" (R2 idiom)
//   S3_ACCESS_KEY_ID       R2 API token access key
//   S3_SECRET_ACCESS_KEY   R2 API token secret
//   S3_BUCKET              bucket name (default kmcp-media)
//   HLS_KEY_PREFIX         key prefix, default "hls"
//   HLS_PUBLIC_BASE        (optional) public/CDN base for reads. If set, GET
//                          returns a redirect to the CDN. Leaving it UNSET keeps
//                          every playback behind this API's admin gate.
//   R2_TIMEOUT_MS          hard per-request timeout, default 4000

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import type { MediaStore, GetResult, PutResult } from "./store";
import { cacheControlFor, contentTypeFor } from "./store";

// Hard per-request timeout for R2 calls. Without this, wrong credentials or an
// unreachable endpoint make the AWS SDK retry with backoff for a long time,
// which hangs the serverless function (the browser then sees a status-0 / no
// response). A short timeout + capped retries makes R2 problems fail FAST and
// visibly instead of hanging the whole request.
const R2_TIMEOUT_MS = Number(process.env.R2_TIMEOUT_MS || 4000);

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`R2 media store: missing env ${name}`);
  return v;
}

export class R2Store implements MediaStore {
  readonly name = "r2";
  private client: S3Client;
  private bucket: string;
  private prefix: string;
  private publicBase: string;

  constructor() {
    this.bucket = process.env.S3_BUCKET || "kmcp-media";
    this.prefix = (process.env.HLS_KEY_PREFIX || "hls").replace(/\/+$/, "");
    this.publicBase = (process.env.HLS_PUBLIC_BASE || "").replace(/\/+$/, "");
    this.client = new S3Client({
      region: process.env.S3_REGION || "auto",
      endpoint: env("S3_ENDPOINT"),
      credentials: {
        accessKeyId: env("S3_ACCESS_KEY_ID"),
        secretAccessKey: env("S3_SECRET_ACCESS_KEY"),
      },
      // Required by R2, MinIO and most S3-compatible providers.
      forcePathStyle: true,
      // Fail fast on bad creds / unreachable R2 instead of hanging the request.
      maxAttempts: 2,
      requestHandler: new NodeHttpHandler({
        connectionTimeout: R2_TIMEOUT_MS,
        requestTimeout: R2_TIMEOUT_MS,
      }),
    });
  }

  private objectKey(streamKey: string, file: string): string {
    return `${this.prefix}/${streamKey}/${file}`;
  }

  async put(streamKey: string, file: string, body: Uint8Array): Promise<PutResult> {
    const { type, kind } = contentTypeFor(file);
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: this.objectKey(streamKey, file),
          Body: body,
          ContentType: type,
          CacheControl: cacheControlFor(kind),
        }),
      );
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "r2 put failed" };
    }
  }

  async get(streamKey: string, file: string): Promise<GetResult> {
    const { type } = contentTypeFor(file);
    // Preferred at scale: redirect the browser to the public/CDN URL so segment
    // bytes never flow through this serverless function. Only when a public base
    // is configured — otherwise reads stay gated through this API.
    if (this.publicBase) {
      return {
        ok: true,
        contentType: type,
        redirectUrl: `${this.publicBase}/${this.objectKey(streamKey, file)}`,
      };
    }
    // Fallback: stream the object back through the app.
    try {
      const res = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: this.objectKey(streamKey, file) }),
      );
      const bytes = await res.Body!.transformToByteArray();
      return { ok: true, body: bytes, contentType: type };
    } catch {
      return { ok: false, error: "not found" };
    }
  }

  async delete(streamKey: string, file: string): Promise<PutResult> {
    try {
      await this.client.send(
        new DeleteObjectCommand({ Bucket: this.bucket, Key: this.objectKey(streamKey, file) }),
      );
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "r2 delete failed" };
    }
  }
}
