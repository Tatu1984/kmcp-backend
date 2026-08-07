import { describe, expect, it, vi } from "vitest";

import { RolesService } from "../src/common/rbac/roles.service";

/**
 * The authorisation decision itself.
 *
 * Now that grants live in the database, this is the code standing between an
 * edited permission row and what the API actually allows. The cases that matter
 * are the refusals and the cache, because a stale grant is an access decision
 * made on out-of-date information.
 */

function makeService(roles: any[]) {
  const findMany = vi.fn().mockResolvedValue(roles);
  const prisma = { role: { findMany } } as any;
  return { service: new RolesService(prisma), findMany };
}

const ADMIN = {
  code: "ADMIN",
  label: "Administrator",
  description: null,
  permissions: ["zone.read", "zone.write"],
  isSystem: true,
  isZoneScoped: false,
  isSuperuser: false,
};

const SUPER = { ...ADMIN, code: "SUPER_ADMIN", permissions: [], isSuperuser: true };
const OFFICER = { ...ADMIN, code: "ZONE_OFFICER", permissions: ["zone.read"], isZoneScoped: true };

describe("resolving permissions", () => {
  it("grants a permission the role holds", async () => {
    const { service } = makeService([ADMIN]);
    expect(await service.can("ADMIN", "zone.write")).toBe(true);
  });

  it("refuses a permission the role does not hold", async () => {
    const { service } = makeService([ADMIN]);
    expect(await service.can("ADMIN", "payment.refund")).toBe(false);
  });

  it("grants everything to a superuser regardless of its list", async () => {
    const { service } = makeService([SUPER]);
    // Its permission list is deliberately empty; the flag is what carries it.
    expect(await service.can("SUPER_ADMIN", "settlement.payout")).toBe(true);
  });

  it("refuses an unknown role outright", async () => {
    const { service } = makeService([ADMIN]);
    // A role deleted from under a live token must mean no access, not all of it.
    expect(await service.can("DELETED_ROLE", "zone.read")).toBe(false);
  });

  it("reports which roles are zone-scoped", async () => {
    const { service } = makeService([ADMIN, OFFICER]);
    expect(await service.isZoneScoped("ZONE_OFFICER")).toBe(true);
    expect(await service.isZoneScoped("ADMIN")).toBe(false);
    expect(await service.isZoneScoped("NO_SUCH_ROLE")).toBe(false);
  });
});

describe("the cache", () => {
  it("reads the database once for many checks", async () => {
    const { service, findMany } = makeService([ADMIN]);

    await service.can("ADMIN", "zone.read");
    await service.can("ADMIN", "zone.write");
    await service.can("ADMIN", "audit.read");

    // This sits in front of every authenticated request; a query per check
    // would put a round trip to Neon ahead of every call a handset makes.
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it("shares one query between concurrent callers on a cold cache", async () => {
    const { service, findMany } = makeService([ADMIN]);

    await Promise.all([
      service.can("ADMIN", "zone.read"),
      service.can("ADMIN", "zone.write"),
      service.can("ADMIN", "slot.write"),
    ]);

    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it("re-reads after being invalidated", async () => {
    const { service, findMany } = makeService([ADMIN]);

    await service.can("ADMIN", "zone.read");
    service.invalidate();
    await service.can("ADMIN", "zone.read");

    // What makes an edit in the portal take effect rather than waiting for a TTL.
    expect(findMany).toHaveBeenCalledTimes(2);
  });

  it("reflects a revoked permission once invalidated", async () => {
    const findMany = vi
      .fn()
      .mockResolvedValueOnce([ADMIN])
      .mockResolvedValueOnce([{ ...ADMIN, permissions: ["zone.read"] }]);
    const service = new RolesService({ role: { findMany } } as any);

    expect(await service.can("ADMIN", "zone.write")).toBe(true);
    service.invalidate();
    expect(await service.can("ADMIN", "zone.write")).toBe(false);
  });
});
