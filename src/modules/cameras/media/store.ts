// Media store abstraction for HLS ingest + playback.
//
// The Edge Agent uploads HLS files (index.m3u8 + .ts segments) via HTTP PUT.
// Those bytes must land somewhere durable and be served back to browsers. Two
// backends implement the same interface, chosen by env (MEDIA_BACKEND):
//
//   - "r2"/"s3" → Cloudflare R2 (S3-compatible). The scale target: durable,
//                 effectively unlimited, ZERO egress fees, CDN-frontable. Works
//                 on Vercel (whose own filesystem is ephemeral).
//   - "fs"      → local filesystem. For dev or a single disk-backed VM.
//
// Ported from the live-feed portal. The interface is deliberately tiny
// (put/get/delete) so a third backend is a drop-in later.

export type ContentKind = "playlist" | "segment" | "other";

export interface PutResult {
  ok: boolean;
  error?: string;
}

export interface GetResult {
  ok: boolean;
  body?: Uint8Array;
  contentType?: string;
  error?: string;
  /** For R2: a redirect/public URL the browser can fetch directly (CDN). */
  redirectUrl?: string;
}

export interface MediaStore {
  /** Store bytes for `<streamKey>/<file>`. */
  put(streamKey: string, file: string, body: Uint8Array): Promise<PutResult>;
  /** Read bytes (or hand back a public URL to redirect to). */
  get(streamKey: string, file: string): Promise<GetResult>;
  /** Delete one object (agent sends DELETE for expired segments). */
  delete(streamKey: string, file: string): Promise<PutResult>;
  /** Human-readable backend name for diagnostics. */
  readonly name: string;
}

// ── shared helpers ────────────────────────────────────────────────────────

const SEGMENT_EXT = new Set([".ts", ".m4s", ".mp4", ".aac", ".vtt"]);
const PLAYLIST_EXT = new Set([".m3u8"]);

/** Only allow safe HLS file names — blocks path traversal and junk uploads. */
export function safeName(file: string): string | null {
  // take just the base name; reject separators / traversal
  const base = file.split("/").pop() || "";
  if (!base || base === "." || base === "..") return null;
  if (base.includes("\\") || base.includes("..")) return null;
  if (!/^[A-Za-z0-9._-]+$/.test(base)) return null;
  const dot = base.lastIndexOf(".");
  const ext = dot >= 0 ? base.slice(dot).toLowerCase() : "";
  if (!SEGMENT_EXT.has(ext) && !PLAYLIST_EXT.has(ext)) return null;
  return base;
}

/** A stream key must be a single safe path segment. */
export function safeKey(streamKey: string): string | null {
  const k = streamKey.trim();
  if (!k || !/^[A-Za-z0-9._-]+$/.test(k) || k === "." || k === "..") return null;
  return k;
}

export function contentTypeFor(file: string): { type: string; kind: ContentKind } {
  const f = file.toLowerCase();
  if (f.endsWith(".m3u8")) return { type: "application/vnd.apple.mpegurl", kind: "playlist" };
  if (f.endsWith(".ts")) return { type: "video/mp2t", kind: "segment" };
  if (f.endsWith(".m4s") || f.endsWith(".mp4")) return { type: "video/mp4", kind: "segment" };
  if (f.endsWith(".aac")) return { type: "audio/aac", kind: "segment" };
  if (f.endsWith(".vtt")) return { type: "text/vtt", kind: "other" };
  return { type: "application/octet-stream", kind: "other" };
}

/**
 * Cache-Control policy — critical for a working, scalable HLS feed:
 *   - playlists (.m3u8): NEVER cache (they change every ~2s).
 *   - segments (.ts …): immutable, cache hard (they never change once written)
 *     so the CDN serves them and origin/R2 fan-out stays low at many viewers.
 */
export function cacheControlFor(kind: ContentKind): string {
  if (kind === "playlist") return "no-cache, no-store, must-revalidate";
  if (kind === "segment") return "public, max-age=31536000, immutable";
  return "public, max-age=60";
}

// ── backend selection ───────────────────────────────────────────────────────

let singleton: MediaStore | null = null;

/** Resolve the configured media store (cached for the process). */
export async function getMediaStore(): Promise<MediaStore> {
  if (singleton) return singleton;
  // trim() so a stray space in the env value (e.g. "r2 ") can't silently fall
  // back to the filesystem backend — a confusing failure on Vercel.
  const backend = (process.env.MEDIA_BACKEND || "").trim().toLowerCase();
  if (backend === "r2" || backend === "s3") {
    const { R2Store } = await import("./r2");
    singleton = new R2Store();
  } else {
    const { FsStore } = await import("./fs");
    singleton = new FsStore();
  }
  return singleton;
}
