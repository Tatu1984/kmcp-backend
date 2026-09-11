// Server-side liveness for a camera's HLS feed. Reads the current playlist from
// the media store (R2 or fs) and classifies it. The browser never probes; it
// only plays the admin-gated playback URL. Ported from the live-feed portal.

import { getMediaStore } from "./media/store";

export type CameraStatus = "ONLINE" | "OFFLINE" | "STOPPED" | "CONNECTING";

/** Build the credential-free playback URL for a camera's playlist. */
export function playbackUrl(ingestKey: string, base = ""): string {
  return `${base}/api/edge/ingest/${ingestKey}/index.m3u8`;
}

function classify(body: string | null): { status: CameraStatus; available: boolean } {
  if (!body) return { status: "OFFLINE", available: false };
  const hasSegments = body.includes("#EXTINF") || /\.ts(\?|\s|$)/m.test(body);
  const ended = body.includes("#EXT-X-ENDLIST");
  if (hasSegments && !ended) return { status: "ONLINE", available: true };
  if (hasSegments && ended) return { status: "STOPPED", available: false };
  return { status: "CONNECTING", available: false };
}

async function readPlaylist(ingestKey: string): Promise<string | null> {
  // Fully guarded: any failure (store init, R2 error/timeout, fetch error) →
  // null → the camera reports OFFLINE. It must NEVER throw/hang, or it would
  // break the whole camera list for every camera.
  try {
    const store = await getMediaStore();
    const res = await store.get(ingestKey, "index.m3u8");
    if (!res.ok) return null;
    if (res.body) return new TextDecoder().decode(res.body);
    // R2 + public base: fetch the playlist text (tiny) to judge liveness.
    if (res.redirectUrl) {
      const r = await fetch(res.redirectUrl, { cache: "no-store" });
      if (!r.ok) return null;
      return await r.text();
    }
    return null;
  } catch {
    return null;
  }
}

export interface CameraLiveness {
  status: CameraStatus;
  available: boolean;
}

/** Read one camera's current liveness from its stored playlist. */
export async function liveness(ingestKey: string): Promise<CameraLiveness> {
  const body = await readPlaylist(ingestKey);
  return classify(body);
}

/** Evaluate many cameras concurrently (bounded). */
export async function livenessMany(
  ingestKeys: string[],
  concurrency = 12,
): Promise<Map<string, CameraLiveness>> {
  const out = new Map<string, CameraLiveness>();
  let i = 0;
  async function worker() {
    while (i < ingestKeys.length) {
      const idx = i++;
      const key = ingestKeys[idx];
      out.set(key, await liveness(key));
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, ingestKeys.length) }, worker),
  );
  return out;
}
