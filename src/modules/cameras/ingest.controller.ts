import {
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Req,
  Res,
} from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";
import { SkipThrottle } from "@nestjs/throttler";
import type { Request, Response } from "express";

import { Public, Roles } from "@/common/decorators/auth.decorators";
import { RawResponse } from "@/common/interceptors/response.interceptor";
import { CamerasService } from "./cameras.service";
import { safeKey, safeName, contentTypeFor, cacheControlFor } from "./media/store";

/**
 * Edge HLS ingest + playback.
 *
 *   PUT/POST/DELETE  /api/edge/ingest/<ingestKey>/<file>   ← Edge Agent
 *       Authorization: Bearer <that camera's ingest token>
 *   GET              /api/edge/ingest/<ingestKey>/<file>   ← browser (ADMIN only)
 *
 * This controller is mounted OUTSIDE the `api/v1` prefix (see main.ts) so the
 * path matches exactly what the live-feed Edge Agent already publishes to — the
 * agent needs only its host and token changed, not its code.
 *
 * Upload: the ingestKey names which camera this is; the bearer token must match
 * that camera's stored hash. Each camera authenticates its own upload, and the
 * bytes land in the media store (R2/fs) under its own key. No user session is
 * involved — the token is the credential.
 *
 * Playback: gated to administrators. Because cameras are an organisation asset
 * (not per-user owned), any admin may watch any camera; a non-admin cannot.
 *
 * These routes are @SkipThrottle: they are the live-video plane, not a user
 * action. A single camera PUTs a segment and rewrites its playlist about every
 * two seconds (~60 requests/min), and a browser fetches a segment about every
 * two seconds per open tile. The global rate limiter counts by client IP and
 * does NOT honour @Public(), so without this a couple of cameras — or one admin
 * watching a few tiles — behind a single site IP would exhaust the 120/min
 * budget and start getting 429s on the uploads and segment fetches themselves,
 * breaking ingest and playback. Auth here is the per-camera token (upload) and
 * the admin JWT (playback), which is the real abuse control.
 */
@ApiExcludeController()
// Every NAMED throttler must be listed. A bare @SkipThrottle() defaults to
// `{ default: true }`, which skips only the throttler called "default" — the
// "strict" one (10/min) stayed armed and 429'd the segment uploads at ~60/min.
@SkipThrottle({ default: true, strict: true })
@Controller("api/edge/ingest")
export class IngestController {
  constructor(private readonly cameras: CamerasService) {}

  private bearer(req: Request): string | null {
    const h = req.headers.authorization || "";
    return h.startsWith("Bearer ") ? h.slice(7) : null;
  }

  /**
   * The exact uploaded bytes as a Buffer.
   *
   * Normally the raw body parser in main.ts has already left a Buffer on
   * req.body. But on a serverless host the app.use mount is not guaranteed to
   * have run for this request, in which case req.body is undefined and the
   * stream is still unread — so fall back to draining it here. This makes the
   * PUT robust regardless of whether the middleware fired.
   */
  private async readBody(req: Request): Promise<Buffer | null> {
    if (Buffer.isBuffer(req.body)) return req.body.length > 0 ? req.body : null;

    // req.body was not populated by the parser — read the raw stream ourselves.
    // If the body was already consumed (readableEnded) and left nothing, treat
    // it as empty rather than hanging.
    if (req.readableEnded) return null;
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const buf = Buffer.concat(chunks);
      return buf.length > 0 ? buf : null;
    } catch {
      return null;
    }
  }

  private async write(req: Request, ingestKey: string, path: string, res: Response) {
    const key = safeKey(ingestKey);
    const file = safeName(path);
    if (!key || !file) return res.status(400).json({ error: "bad path" });

    const cam = await this.cameras.authenticateIngest(key, this.bearer(req));
    if (!cam) return res.status(401).json({ error: "unauthorized" });

    const body = await this.readBody(req);
    if (!body) return res.status(400).json({ error: "empty body" });

    const result = await this.cameras.putMedia(key, file, new Uint8Array(body));
    if (!result.ok) return res.status(500).json({ error: result.error || "write failed" });
    return res.status(201).end();
  }

  @Public()
  @Put(":ingestKey/*path")
  put(
    @Req() req: Request,
    @Res() res: Response,
    @Param("ingestKey") ingestKey: string,
    @Param("path") path: string,
  ) {
    return this.write(req, ingestKey, path, res);
  }

  @Public()
  @Post(":ingestKey/*path")
  post(
    @Req() req: Request,
    @Res() res: Response,
    @Param("ingestKey") ingestKey: string,
    @Param("path") path: string,
  ) {
    return this.write(req, ingestKey, path, res);
  }

  @Public()
  @Delete(":ingestKey/*path")
  async remove(
    @Req() req: Request,
    @Res() res: Response,
    @Param("ingestKey") ingestKey: string,
    @Param("path") path: string,
  ) {
    const key = safeKey(ingestKey);
    const file = safeName(path);
    if (!key || !file) return res.status(400).json({ error: "bad path" });
    const cam = await this.cameras.authenticateIngest(key, this.bearer(req));
    if (!cam) return res.status(401).json({ error: "unauthorized" });
    await this.cameras.deleteMedia(key, file);
    return res.status(204).end();
  }

  /**
   * Playback — administrators only. Serves the bytes through this API rather
   * than a public URL so the admin gate cannot be side-stepped with the URL.
   */
  @Roles("SUPER_ADMIN", "ADMIN")
  @RawResponse()
  @Get(":ingestKey/*path")
  async play(
    @Res() res: Response,
    @Param("ingestKey") ingestKey: string,
    @Param("path") path: string,
  ) {
    const key = safeKey(ingestKey);
    const file = safeName(path);
    if (!key || !file) return res.status(400).json({ error: "bad path" });

    // The camera must exist; any admin may then watch it.
    if (!(await this.cameras.ingestKeyExists(key))) {
      return res.status(404).json({ error: "not found" });
    }

    const result = await this.cameras.getMedia(key, file);
    if (!result.ok) return res.status(404).json({ error: "not found" });

    const { type, kind } = contentTypeFor(file);

    // With a public CDN base configured the store hands back a redirect URL, but
    // we still stream it through here so playback stays admin-gated.
    if (result.redirectUrl && !result.body) {
      const upstream = await fetch(result.redirectUrl, { cache: "no-store" });
      if (!upstream.ok) return res.status(404).json({ error: "not found" });
      const buf = Buffer.from(await upstream.arrayBuffer());
      res.setHeader("Content-Type", type);
      res.setHeader("Cache-Control", cacheControlFor(kind));
      return res.status(200).end(buf);
    }

    res.setHeader("Content-Type", result.contentType || type);
    res.setHeader("Cache-Control", cacheControlFor(kind));
    return res.status(200).end(result.body ? Buffer.from(result.body) : undefined);
  }
}
