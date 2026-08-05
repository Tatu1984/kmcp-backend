import { generateSecret, generateURI, verifySync } from "otplib";

/**
 * Thin wrapper over otplib so the rest of the codebase never touches its API
 * directly. otplib 13 replaced the old `authenticator` singleton with free
 * functions; keeping that behind this file means the next such change is a
 * one-file edit.
 */

export const generateTotpSecret = (): string => generateSecret({ length: 20 });

export const totpKeyUri = (account: string, issuer: string, secret: string): string =>
  generateURI({ strategy: "totp", issuer, label: account, secret });

/**
 * Verifies a 6-digit code. A one-step window each way is allowed so a phone
 * whose clock drifts by a few seconds still works at the kerb.
 */
export function verifyTotp(token: string, secret: string): boolean {
  try {
    const result = verifySync({ strategy: "totp", secret, token, epochTolerance: 1 });
    return result.valid;
  } catch {
    return false;
  }
}
