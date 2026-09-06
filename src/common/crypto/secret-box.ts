import crypto from "node:crypto";

import { AppException } from "@/common/errors/app.exception";

/**
 * Symmetric encryption for the few values that must be stored and later used,
 * rather than stored and later compared.
 *
 * A password is hashed, never encrypted — bcrypt, in AuthService, and there is
 * no way back from it by design. A camera's password is different: the gateway
 * has to present it to the camera, so the server needs the plaintext back. That
 * is a genuinely reversible secret and this is the only kind of value that
 * belongs here.
 *
 * AES-256-GCM, which authenticates as well as encrypts: tampering with the
 * stored ciphertext produces an error rather than a plausible wrong answer.
 * Each value carries its own random salt and IV, so the same password stored
 * against two cameras produces two unrelated ciphertexts and the column cannot
 * be read for equality.
 */

const ALGORITHM = "aes-256-gcm";
const SALT_BYTES = 32;
const IV_BYTES = 12; // 96 bits, which is what GCM is specified around.
const VERSION = "v1";

/**
 * Derives the key for one value from the master key and that value's salt.
 *
 * scrypt rather than a bare hash so a leaked key is expensive to attack
 * offline. The parameters are Node's defaults (N=16384, r=8, p=1): about 16 MB
 * and a few milliseconds per call, which is fine for something that happens
 * when a camera is registered and when a stream is set up, and would not be if
 * this were on a request path.
 */
function deriveKey(masterKey: string, salt: Buffer): Buffer {
  return crypto.scryptSync(masterKey, salt, 32);
}

/**
 * Refuses rather than falls back.
 *
 * A development default here would write ciphertext encrypted with a key that
 * is in the repository — indistinguishable, in the database and in every
 * backup, from a value that is actually protected. Better to say what is
 * missing at the moment somebody tries to store a secret.
 */
function requireKey(masterKey: string | undefined): string {
  if (!masterKey) {
    throw new AppException(
      "VALIDATION_FAILED",
      [{ field: "password", issue: "no encryption key is configured" }],
      "This deployment cannot store camera credentials: ENCRYPTION_KEY is not set. Set it " +
        "and restart, or register the camera without a username and password.",
    );
  }
  return masterKey;
}

/** `v1:salt:iv:tag:ciphertext`, each part base64. */
export function encryptSecret(plaintext: string, masterKey: string | undefined): string {
  const key = requireKey(masterKey);
  const salt = crypto.randomBytes(SALT_BYTES);
  const iv = crypto.randomBytes(IV_BYTES);

  const cipher = crypto.createCipheriv(ALGORITHM, deriveKey(key, salt), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    VERSION,
    salt.toString("base64"),
    iv.toString("base64"),
    tag.toString("base64"),
    ciphertext.toString("base64"),
  ].join(":");
}

/**
 * Returns the plaintext, or throws.
 *
 * Every failure here — a rotated key, a truncated column, a value written by
 * some other scheme — is indistinguishable from tampering and is treated the
 * same way. Callers turn it into "this camera's credentials cannot be read"
 * rather than guessing.
 */
export function decryptSecret(stored: string, masterKey: string | undefined): string {
  const key = requireKey(masterKey);
  const parts = stored.split(":");

  if (parts.length !== 5 || parts[0] !== VERSION) {
    throw new Error("Stored secret is not in the expected format");
  }

  const [, saltB64, ivB64, tagB64, dataB64] = parts;
  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    deriveKey(key, Buffer.from(saltB64, "base64")),
    Buffer.from(ivB64, "base64"),
  );
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));

  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

/** True when a column holds something this module wrote. */
export function isEncryptedSecret(value: string | null | undefined): boolean {
  if (!value) return false;
  const parts = value.split(":");
  return parts.length === 5 && parts[0] === VERSION && parts.every((p) => p.length > 0);
}
