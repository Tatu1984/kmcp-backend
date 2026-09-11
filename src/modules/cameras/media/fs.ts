// Local-filesystem media store — for development or a single disk-backed VM.
// NOT for Vercel (ephemeral FS). Writes are atomic (temp + rename) so a reader
// never sees a half-written segment/playlist. Ported from the live-feed portal.
//
// Env:
//   MEDIA_BACKEND=fs         (or unset — fs is the default)
//   MEDIA_FS_DIR             root dir for segments (default ./.media)

import { promises as fs } from "node:fs";
import path from "node:path";
import type { MediaStore, GetResult, PutResult } from "./store";
import { contentTypeFor } from "./store";

export class FsStore implements MediaStore {
  readonly name = "fs";
  private root: string;

  constructor() {
    this.root = process.env.MEDIA_FS_DIR || path.join(process.cwd(), ".media");
  }

  private full(streamKey: string, file: string): string {
    return path.join(this.root, streamKey, file);
  }

  async put(streamKey: string, file: string, body: Uint8Array): Promise<PutResult> {
    const dest = this.full(streamKey, file);
    try {
      await fs.mkdir(path.dirname(dest), { recursive: true });
      const tmp = `${dest}.tmp-${process.pid}-${Date.now()}`;
      await fs.writeFile(tmp, body);
      await fs.rename(tmp, dest);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "fs put failed" };
    }
  }

  async get(streamKey: string, file: string): Promise<GetResult> {
    const { type } = contentTypeFor(file);
    try {
      const buf = await fs.readFile(this.full(streamKey, file));
      return { ok: true, body: new Uint8Array(buf), contentType: type };
    } catch {
      return { ok: false, error: "not found" };
    }
  }

  async delete(streamKey: string, file: string): Promise<PutResult> {
    try {
      await fs.rm(this.full(streamKey, file), { force: true });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "fs delete failed" };
    }
  }
}
