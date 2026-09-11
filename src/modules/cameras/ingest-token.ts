// Per-camera ingest tokens, ported from the live-feed portal.
//
// Each camera has an `ingestKey` (a public, unguessable segment in the ingest
// URL path) and an ingest token the Edge Agent sends as `Authorization: Bearer
// <token>`. Only the SHA-256 hash of the token is stored, so it is shown to the
// operator exactly once — on creation or rotation — and can never be recovered.
//
// This is a standalone credential for one camera's upload. It is unrelated to
// KMCP's user authentication (JWT), which gates who may register or watch a
// camera; this only authenticates one device's HTTP PUTs.

import { randomBytes, createHash, timingSafeEqual } from "node:crypto";

/** A fresh opaque ingest token the operator pastes into the Edge Agent. */
export function newIngestToken(): string {
  return "ing_" + randomBytes(24).toString("base64url");
}

/** Store only the hash of an ingest token; compare hashes on upload. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Constant-time comparison of a presented token against a stored hash. */
export function verifyToken(token: string, storedHash: string): boolean {
  const a = Buffer.from(hashToken(token), "hex");
  const b = Buffer.from(storedHash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** A short random stream key used in the public ingest/playback URL path. */
export function newIngestKey(): string {
  return randomBytes(12).toString("base64url");
}
