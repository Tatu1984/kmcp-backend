import { describe, expect, it } from "vitest";

import { LoginSchema } from "../src/modules/auth/dto/auth.dto";

/**
 * Which identifier signs you in.
 *
 * Portal staff have work email addresses; attendants are seeded with a phone
 * and no email at all, so an email-only login could not authenticate the people
 * who use this platform most. Exactly one identifier is required — accepting
 * both would leave the service picking which one to trust.
 */
describe("signing in", () => {
  const password = "kmcp-demo-2026";

  it("accepts a work email", () => {
    const parsed = LoginSchema.safeParse({ email: "admin@kmc.gov.in", password });
    expect(parsed.success).toBe(true);
  });

  it("accepts a bare Indian mobile number and stores it in full", () => {
    const parsed = LoginSchema.safeParse({ phone: "9831550101", password });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.phone).toBe("+919831550101");
  });

  it("accepts a mobile number that already carries its country code", () => {
    const parsed = LoginSchema.safeParse({ phone: "+919831550101", password });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.phone).toBe("+919831550101");
  });

  it("refuses both at once, so the server never has to choose", () => {
    const parsed = LoginSchema.safeParse({
      email: "admin@kmc.gov.in",
      phone: "9831550101",
      password,
    });
    expect(parsed.success).toBe(false);
  });

  it("refuses neither", () => {
    expect(LoginSchema.safeParse({ password }).success).toBe(false);
  });

  it("refuses a landline or a malformed mobile", () => {
    expect(LoginSchema.safeParse({ phone: "03322334455", password }).success).toBe(false);
    expect(LoginSchema.safeParse({ phone: "12345", password }).success).toBe(false);
  });

  it("still requires a password of a sensible length", () => {
    expect(LoginSchema.safeParse({ phone: "9831550101", password: "abc" }).success).toBe(false);
  });

  it("defaults the platform to web, so the portal need not send one", () => {
    const parsed = LoginSchema.safeParse({ email: "admin@kmc.gov.in", password });
    if (parsed.success) expect(parsed.data.platform).toBe("web");
  });
});
