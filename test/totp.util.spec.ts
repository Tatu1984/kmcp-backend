import { describe, expect, it } from "vitest";

import {
  generateTotpSecret,
  totpAt,
  totpKeyUri,
  verifyTotp,
} from "../src/common/utils/totp.util";

/**
 * TOTP is hand-rolled here (see the note in totp.util.ts), so it is pinned to
 * the published RFC vectors rather than to its own output. If this file passes,
 * any authenticator app agrees with us.
 */

// RFC 6238 Appendix B uses the ASCII secret "12345678901234567890".
// Base32 of those bytes:
const RFC_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

describe("totp", () => {
  // Appendix B publishes 8-digit codes; these are the low six of the SHA-1 rows.
  it.each([
    [59, "287082"],
    [1111111109, "081804"],
    [1111111111, "050471"],
    [1234567890, "005924"],
    [2000000000, "279037"],
  ])("matches the RFC 6238 vector at T=%i", (epoch, expected) => {
    expect(totpAt(RFC_SECRET, epoch)).toBe(expected);
  });

  it("accepts the code for the current step", () => {
    const now = 1_700_000_000_000;
    expect(verifyTotp(totpAt(RFC_SECRET, now / 1000), RFC_SECRET, now)).toBe(true);
  });

  it("tolerates one step of clock drift either way", () => {
    const now = 1_700_000_000_000;
    for (const drift of [-30, 30]) {
      expect(verifyTotp(totpAt(RFC_SECRET, now / 1000 + drift), RFC_SECRET, now)).toBe(true);
    }
  });

  it("rejects a code two steps out", () => {
    const now = 1_700_000_000_000;
    for (const drift of [-60, 60]) {
      expect(verifyTotp(totpAt(RFC_SECRET, now / 1000 + drift), RFC_SECRET, now)).toBe(false);
    }
  });

  it("rejects malformed input without throwing", () => {
    expect(verifyTotp("", RFC_SECRET)).toBe(false);
    expect(verifyTotp("12345", RFC_SECRET)).toBe(false);
    expect(verifyTotp("abcdef", RFC_SECRET)).toBe(false);
    expect(verifyTotp("1234567", RFC_SECRET)).toBe(false);
    expect(verifyTotp("123456", "not-base32!")).toBe(false);
  });

  it("issues a 160-bit base32 secret that round-trips", () => {
    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    const now = Date.now();
    expect(verifyTotp(totpAt(secret, now / 1000), secret, now)).toBe(true);
  });

  it("builds a key URI an authenticator app can read", () => {
    const uri = totpKeyUri("prabir.c@kmc.gov.in", "KMCP", RFC_SECRET);
    expect(uri).toContain("otpauth://totp/KMCP:prabir.c%40kmc.gov.in?");
    expect(uri).toContain(`secret=${RFC_SECRET}`);
    expect(uri).toContain("algorithm=SHA1");
    expect(uri).toContain("digits=6");
    expect(uri).toContain("period=30");
  });
});
