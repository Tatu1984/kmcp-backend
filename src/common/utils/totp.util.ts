import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * TOTP (RFC 6238) over HMAC-SHA1, six digits, thirty-second steps — the
 * settings every authenticator app assumes when a QR code omits them.
 *
 * Implemented directly on node:crypto rather than through otplib. otplib 13
 * reaches ESM-only packages (@scure/base, @noble/hashes) from CommonJS entry
 * points, and Vercel loads the function with a bundler whose require() cannot
 * read ES modules — the whole API failed to boot on that alone, sign-in
 * included. The algorithm is small, fixed by standard, and covered by the RFC
 * test vectors in test/totp.util.spec.ts, so owning it costs less than
 * fighting someone else's module graph.
 */

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const DIGITS = 6;
const STEP_SECONDS = 30;

/** RFC 4648 base32, unpadded — the form authenticator apps expect. */
function base32Encode(bytes: Buffer): string {
  let bits = "";
  let out = "";
  for (const byte of bytes) bits += byte.toString(2).padStart(8, "0");
  for (let i = 0; i < bits.length; i += 5) {
    const chunk = bits.slice(i, i + 5).padEnd(5, "0");
    out += BASE32_ALPHABET[parseInt(chunk, 2)];
  }
  return out;
}

function base32Decode(secret: string): Buffer {
  const clean = secret.toUpperCase().replace(/=+$/, "").replace(/\s/g, "");
  let bits = "";
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) throw new Error("Secret is not valid base32");
    bits += index.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  // Trailing bits that do not complete a byte are padding, not data.
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

/** The HOTP of RFC 4226, which TOTP is just a time-derived counter for. */
function hotp(key: Buffer, counter: number): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));

  const digest = createHmac("sha1", key).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);

  return String(binary % 10 ** DIGITS).padStart(DIGITS, "0");
}

/** A 160-bit secret, the size RFC 4226 recommends for HMAC-SHA1. */
export const generateTotpSecret = (): string => base32Encode(randomBytes(20));

/** The code for a given moment. Exported for the tests and for enrolment QA. */
export function totpAt(secret: string, epochSeconds: number): string {
  return hotp(base32Decode(secret), Math.floor(epochSeconds / STEP_SECONDS));
}

export function totpKeyUri(account: string, issuer: string, secret: string): string {
  // The issuer appears twice by design: in the label for older apps, and as a
  // parameter for ones that read it properly.
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: "SHA1",
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/**
 * Verifies a 6-digit code. One step either way is allowed so a phone whose
 * clock drifts by a few seconds still works at the kerb.
 *
 * Compared in constant time: a timing difference on OTP comparison is a real,
 * if slow, way to learn a code.
 */
export function verifyTotp(token: string, secret: string, now = Date.now()): boolean {
  const candidate = token.trim();
  if (!/^\d{6}$/.test(candidate)) return false;

  let key: Buffer;
  try {
    key = base32Decode(secret);
  } catch {
    return false;
  }

  const counter = Math.floor(now / 1000 / STEP_SECONDS);
  const supplied = Buffer.from(candidate);

  let valid = false;
  for (const drift of [-1, 0, 1]) {
    const expected = Buffer.from(hotp(key, counter + drift));
    // No early return: every window is checked so the time taken does not
    // reveal which one matched.
    if (expected.length === supplied.length && timingSafeEqual(expected, supplied)) valid = true;
  }
  return valid;
}
