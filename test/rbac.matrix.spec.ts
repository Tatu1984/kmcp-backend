import { beforeAll, describe, expect, it } from "vitest";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { RequestMethod, type ExecutionContext } from "@nestjs/common";
import { METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { Reflector } from "@nestjs/core";

import { AuthService } from "../src/modules/auth/auth.service";
import { RbacGuard } from "../src/common/guards/rbac.guard";
import { RolesService } from "../src/common/rbac/roles.service";
import {
  PERMISSIONS,
  PERMISSION_GROUPS,
  ungroupedPermissions,
  type Permission,
} from "../src/common/rbac/permissions";
import {
  IS_PUBLIC_KEY,
  PERMISSIONS_KEY,
  ROLES_KEY,
  type AuthenticatedUser,
} from "../src/common/decorators/auth.decorators";

/**
 * The permission matrix, made executable.
 *
 * The RBAC in this API is only as good as the decorators actually written on
 * the handlers, and nothing has ever checked those. A route added without a
 * `@RequirePermissions` is open to every signed-in citizen; a permission string
 * with a typo in it is a checkbox in the portal that grants nothing and a guard
 * that refuses everyone. Neither shows up in a code review, and neither shows
 * up in production until someone reads data they should not have.
 *
 * So this file does not hold a list of routes. It walks the controllers, reads
 * the metadata Nest itself will read at runtime, and drives the real guard with
 * the real grants for all seven seeded roles. A route added tomorrow is in the
 * matrix tomorrow, whether or not anybody remembered to come here.
 */

// --------------------------------------------------------------- discovery

interface DiscoveredRoute {
  /** `ZonesController.list` — how a failure is reported. */
  readonly id: string;
  /** `GET /zones` — how a human recognises it. */
  readonly signature: string;
  readonly controller: Function;
  readonly handler: Function;
  readonly isPublic: boolean;
  readonly roles: string[];
  readonly permissions: Permission[];
}

const MODULES_DIR = path.resolve(__dirname, "../src/modules");

function controllerFiles(dir: string): string[] {
  return readdirSync(dir)
    .flatMap((entry) => {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) return controllerFiles(full);
      return full.endsWith(".controller.ts") ? [full] : [];
    })
    .sort();
}

function joinPath(...segments: unknown[]): string {
  const parts = segments
    .flatMap((s) => (Array.isArray(s) ? s : [s]))
    .filter((s): s is string => typeof s === "string");
  return `/${parts.join("/")}`.replace(/\/+/g, "/").replace(/(.)\/$/, "$1");
}

/** Everything Nest will mount, read the way Nest reads it. */
async function discover(): Promise<DiscoveredRoute[]> {
  const reflector = new Reflector();
  const perFile = await Promise.all(
    controllerFiles(MODULES_DIR).map(async (file) => {
      const module: Record<string, unknown> = await import(file);
      return Object.entries(module).flatMap(([exportName, exported]) => {
        if (typeof exported !== "function") return [];
        const basePath = Reflect.getMetadata(PATH_METADATA, exported);
        // Anything without a controller path is a DTO, a helper or a type.
        if (basePath === undefined) return [];

        const prototype = exported.prototype as Record<string, Function>;
        return Object.getOwnPropertyNames(prototype).flatMap((key) => {
          if (key === "constructor") return [];
          const handler = prototype[key];
          const verb = Reflect.getMetadata(METHOD_METADATA, handler);
          if (verb === undefined) return [];

          const targets = [handler, exported] as [Function, Function];
          return [
            {
              id: `${exportName}.${key}`,
              signature: `${RequestMethod[verb]} ${joinPath(
                basePath,
                Reflect.getMetadata(PATH_METADATA, handler),
              )}`,
              controller: exported,
              handler,
              isPublic: reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets) === true,
              roles: reflector.getAllAndOverride<string[]>(ROLES_KEY, targets) ?? [],
              permissions: reflector.getAllAndOverride<Permission[]>(PERMISSIONS_KEY, targets) ?? [],
            } satisfies DiscoveredRoute,
          ];
        });
      });
    }),
  );
  return perFile.flat();
}

/**
 * Populated once, before anything runs. Every assertion below reaches for these
 * from inside a test body rather than while the file is being collected, so the
 * import of two dozen controllers happens in one place and is awaited properly.
 */
let ROUTES: DiscoveredRoute[] = [];
let PERMISSIONED: DiscoveredRoute[] = [];
let UNGUARDED: DiscoveredRoute[] = [];

beforeAll(async () => {
  ROUTES = await discover();
  PERMISSIONED = ROUTES.filter((r) => r.permissions.length > 0);
  UNGUARDED = ROUTES.filter(
    (r) => !r.isPublic && r.roles.length === 0 && r.permissions.length === 0,
  );
});

/** `ZonesController.list` — reads better in a test than an index into an array. */
function route(id: string): DiscoveredRoute {
  const found = ROUTES.find((r) => r.id === id);
  if (!found) throw new Error(`No route discovered for ${id}`);
  return found;
}

// ------------------------------------------------------------ seeded roles

/**
 * The seven system roles exactly as `20260807120000_roles_into_the_database`
 * writes them, which is the only thing that ever writes them — the seed script
 * does not touch the `Role` table.
 *
 * They are spelled out here rather than read over a connection so the matrix
 * runs in CI, where there is no database. The conformance test below reads the
 * real table whenever a `DATABASE_URL` is present, so the copy cannot drift
 * unnoticed.
 */
const SEEDED_ROLES = [
  {
    code: "SUPER_ADMIN",
    isSuperuser: true,
    isZoneScoped: false,
    // Deliberately empty: the flag carries it, not the list.
    permissions: [] as Permission[],
  },
  {
    code: "ADMIN",
    isSuperuser: false,
    isZoneScoped: false,
    permissions: [
      "zone.read", "zone.write", "zone.status", "slot.write",
      "session.read", "session.cancel", "incident.manage",
      "vendor.read", "vendor.write", "vendor.approve", "attendant.write", "shift.verify",
      "tariff.read", "tariff.write", "tariff.publish", "discount.write", "pass.write",
      "payment.read", "payment.refund", "settlement.read", "settlement.approve", "settlement.payout",
      "report.generate", "audit.read", "user.manage", "cms.write",
      // Not config.write — an administrator runs the city, not the platform.
    ] as Permission[],
  },
  {
    code: "ZONE_OFFICER",
    isSuperuser: false,
    isZoneScoped: true,
    permissions: [
      "zone.read", "zone.status", "session.read", "incident.manage",
      "vendor.read", "tariff.read", "report.generate",
    ] as Permission[],
  },
  {
    code: "AUDITOR",
    isSuperuser: false,
    isZoneScoped: false,
    permissions: [
      "zone.read", "session.read", "vendor.read", "tariff.read",
      "payment.read", "settlement.read", "report.generate", "audit.read",
    ] as Permission[],
  },
  {
    code: "VENDOR",
    isSuperuser: false,
    isZoneScoped: true,
    permissions: [
      "zone.read", "session.read", "attendant.write", "payment.read", "settlement.read",
    ] as Permission[],
  },
  {
    code: "ATTENDANT",
    isSuperuser: false,
    isZoneScoped: true,
    permissions: ["zone.read", "session.read"] as Permission[],
  },
  {
    code: "CITIZEN",
    isSuperuser: false,
    isZoneScoped: false,
    // The public app holds no portal permission at all.
    permissions: [] as Permission[],
  },
] as const;

/** A RolesService reading the seeded rows, so the guard runs its real logic. */
function seededRolesService(): RolesService {
  const rows = SEEDED_ROLES.map((role) => ({
    ...role,
    label: role.code,
    description: null,
    isSystem: true,
    permissions: [...role.permissions],
  }));
  return new RolesService({ role: { findMany: async () => rows } } as never);
}

function principal(role: string): AuthenticatedUser {
  return {
    id: `usr_${role.toLowerCase()}`,
    role,
    isZoneScoped: SEEDED_ROLES.find((r) => r.code === role)!.isZoneScoped,
    name: role,
    zoneIds: [],
    sessionId: "ses_1",
  };
}

/** The guard only ever reads the handler, the class and `request.user`. */
function contextFor(route: DiscoveredRoute, user: AuthenticatedUser | undefined): ExecutionContext {
  return {
    getHandler: () => route.handler,
    getClass: () => route.controller,
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

async function verdict(
  guard: RbacGuard,
  route: DiscoveredRoute,
  user: AuthenticatedUser | undefined,
): Promise<boolean> {
  try {
    return await guard.canActivate(contextFor(route, user));
  } catch {
    // The guard refuses by throwing; for the matrix a refusal is just `false`.
    return false;
  }
}

// ------------------------------------------------------------------- tests

describe("discovering the routes", () => {
  it("finds controllers to check", () => {
    // If the walker ever finds nothing, every other assertion in this file
    // passes vacuously. This is the tripwire for that.
    expect(ROUTES.length).toBeGreaterThan(150);
    expect(PERMISSIONED.length).toBeGreaterThan(150);
  });

  it("reads the guard metadata off a route whose answer is known by hand", () => {
    expect(route("ZonesController.list").permissions).toEqual(["zone.read"]);
    expect(route("ZonesController.nearby").isPublic).toBe(true);
    expect(route("AuthController.disableTwoFactor").roles).toEqual(["SUPER_ADMIN"]);
  });
});

describe("every route says how it is guarded", () => {
  /**
   * Routes with no `@Public`, no `@Roles` and no `@RequirePermissions`.
   *
   * `RbacGuard` waves these through for anyone holding a valid token, which
   * includes every citizen who has ever signed in to the public app. That is
   * correct only for genuinely self-service routes — ones that operate on the
   * caller's own account and can reach nobody else's data.
   *
   * Each entry below has been read and is legitimate. A new name appearing in
   * the failure diff is not a reason to add it here; it is a reason to go and
   * put a permission on the route.
   */
  const SELF_SERVICE_BY_DESIGN = [
    // --- your own session and account (AuthController) ---
    // All of these take the principal from the token and never a caller-supplied
    // id, so there is no other account for them to touch.
    "AuthController.logoutAll", // revokes your own tokens
    "AuthController.me", // your own principal
    "AuthController.changePassword", // requires your current password
    "AuthController.setupTwoFactor", // enrols your own authenticator
    "AuthController.confirmTwoFactor", // confirms your own enrolment
    "AuthController.bindDevice", // registers the handset you are holding
    "AuthController.listDevices", // your own bound devices
    "AuthController.unbindDevice", // scoped to your own devices in the service

    // --- your own location consent (ActivityController, mounted under /auth) ---
    "ActivityController.getConsent", // your own consent flag
    "ActivityController.setConsent", // granting or withdrawing it is yours to do

    // --- your own consent record (PrivacyController) ---
    // Both take the subject from the token. `ownConsents` reads the caller's own
    // ledger; `giveConsent` appends to it and can only ever name `user.id`. The
    // officer-facing view of somebody else's record is a different route and
    // carries user.manage.
    "PrivacyController.ownConsents",
    "PrivacyController.giveConsent",

    // --- media (MediaController) ---
    // Uploading is open by design: attendants photograph plates and vendors
    // supply KYC, and what may be uploaded is constrained by purpose and MIME
    // type rather than by role. Reading is by opaque id and returns a
    // short-lived signed URL; listing and deleting are behind audit.read and
    // config.write respectively.
    "MediaController.requestUpload",
    "MediaController.confirmUpload",
    "MediaController.signedUrl",
    "MediaController.signedUrls",

    // --- your own alerts (NotificationsController) ---
    // Every method in NotificationsService is written `where: { userId: user.id }`
    // — including markRead and dismiss, which scope by id *and* userId so a
    // guessed id belonging to somebody else touches nothing and reports
    // not-found. The row set is the authorisation; a permission check here
    // would be asking the wrong question.
    "NotificationsController.list",
    "NotificationsController.unreadCount",
    "NotificationsController.markAllRead",
    "NotificationsController.markRead",
    "NotificationsController.dismiss",

    // --- which channels this deployment can send on (MessagingController) ---
    // Returns three booleans and the template catalogue: no person, no address,
    // no message. Every screen with a "send" control reads it to decide whether
    // to offer WhatsApp at all, which is a better experience than offering it
    // and reporting a failure the operator can do nothing about. The routes
    // that actually send are each behind the permission their subject already
    // requires — payment.read, pass.write, user.manage, report.generate — and
    // the delivery log is behind audit.read.
    "MessagingController.channels",
  ];

  it("carries a permission, a role or an explicit exemption", () => {
    expect(UNGUARDED.map((r) => r.id).sort()).toEqual([...SELF_SERVICE_BY_DESIGN].sort());
  });

  it("keeps the exemption list honest in both directions", () => {
    // No duplicates, and nothing left behind pointing at a route that no longer
    // exists — a stale entry would quietly widen the list the next time a route
    // of that name came back.
    expect(new Set(SELF_SERVICE_BY_DESIGN).size).toBe(SELF_SERVICE_BY_DESIGN.length);

    const known = new Set(ROUTES.map((r) => r.id));
    expect(SELF_SERVICE_BY_DESIGN.filter((id) => !known.has(id))).toEqual([]);
  });

  it("declares only permissions the catalogue knows how to enforce", () => {
    const catalogue = new Set<string>(PERMISSIONS);
    const unknown = ROUTES.flatMap((route) =>
      route.permissions.filter((p) => !catalogue.has(p)).map((p) => `${route.id} → ${p}`),
    );
    // A typo here is silent: the string matches no grant, so the guard refuses
    // every role including the ones that were meant to have it.
    expect(unknown).toEqual([]);
  });
});

describe("the permission catalogue", () => {
  it("puts every permission in exactly one group", () => {
    expect(ungroupedPermissions()).toEqual([]);

    const counts = new Map<string, number>();
    for (const group of PERMISSION_GROUPS) {
      for (const entry of group.permissions) {
        counts.set(entry.key, (counts.get(entry.key) ?? 0) + 1);
      }
    }
    expect([...counts.entries()].filter(([, n]) => n !== 1)).toEqual([]);
  });

  it("groups nothing that is not a permission", () => {
    const catalogue = new Set<string>(PERMISSIONS);
    const strays = PERMISSION_GROUPS.flatMap((g) =>
      g.permissions.map((p) => p.key).filter((k) => !catalogue.has(k)),
    );
    expect(strays).toEqual([]);
  });

  it("is enforced in full — no permission grants nothing", () => {
    const declared = new Set(ROUTES.flatMap((r) => r.permissions));
    // A permission no route ever requires is a checkbox in the portal that
    // changes nothing, which is worse than not offering it.
    expect(PERMISSIONS.filter((p) => !declared.has(p))).toEqual([]);
  });
});

describe("the guard before it has a principal", () => {
  const guard = new RbacGuard(new Reflector(), seededRolesService());

  it("lets a public route through with no token at all", async () => {
    const publicRoute = ROUTES.find((r) => r.isPublic)!;
    expect(await guard.canActivate(contextFor(publicRoute, undefined))).toBe(true);
  });

  it("refuses a permissioned route with no token at all", async () => {
    expect(await verdict(guard, PERMISSIONED[0], undefined)).toBe(false);
  });

  it("refuses a role that no longer exists", async () => {
    // A role deleted from under a live token means no access, not all of it.
    const ghost = { ...principal("ADMIN"), role: "DELETED_ROLE" };
    expect(await verdict(guard, route("ZonesController.list"), ghost)).toBe(false);
  });
});

/**
 * The matrix itself: every seeded role against every permissioned route.
 *
 * Both halves are asserted. A regression that opens a route to everyone shows
 * up in the allow list; a regression that closes one to the people who need it
 * shows up in the deny list.
 */
describe.each(SEEDED_ROLES)("$code", (role) => {
  const guard = new RbacGuard(new Reflector(), seededRolesService());
  const user = principal(role.code);
  const granted = new Set<string>(role.permissions);

  /** What the seeded grants say the answer should be, before asking the guard. */
  const expected = (candidate: DiscoveredRoute) =>
    role.isSuperuser || candidate.permissions.every((p) => granted.has(p));

  async function actualVerdicts(): Promise<Map<DiscoveredRoute, boolean>> {
    const entries = await Promise.all(
      PERMISSIONED.map(async (r) => [r, await verdict(guard, r, user)] as const),
    );
    return new Map(entries);
  }

  it("is allowed exactly the routes its grants cover", async () => {
    const actual = await actualVerdicts();
    expect([...actual].filter(([, ok]) => ok).map(([r]) => r.signature).sort()).toEqual(
      PERMISSIONED.filter(expected).map((r) => r.signature).sort(),
    );
  });

  it("is refused every route its grants do not cover", async () => {
    const actual = await actualVerdicts();
    expect([...actual].filter(([, ok]) => !ok).map(([r]) => r.signature).sort()).toEqual(
      PERMISSIONED.filter((r) => !expected(r)).map((r) => r.signature).sort(),
    );
  });

  it("meets the role-restricted route only if it is that role", async () => {
    const superAdminOnly = route("AuthController.disableTwoFactor");
    expect(await verdict(guard, superAdminOnly, user)).toBe(role.code === "SUPER_ADMIN");
  });

  it("reaches every public route", async () => {
    const results = await Promise.all(
      ROUTES.filter((r) => r.isPublic).map((r) => verdict(guard, r, user)),
    );
    expect(results.every(Boolean)).toBe(true);
  });
});

/**
 * A handful of answers written out by hand.
 *
 * The matrix above derives what it expects from the same two facts the guard
 * reads — the decorator and the grant — which is what makes it able to cover
 * every route, but also means it would agree with itself if the grants were
 * wrong. These are the anchors: the answers a person would give, spelled out,
 * so a grant edited in the wrong direction cannot pass unnoticed.
 */
describe("answers written out by hand", () => {
  const guard = new RbacGuard(new Reflector(), seededRolesService());

  const CASES: [routeId: string, role: string, allowed: boolean][] = [
    // An auditor reads everything and changes nothing.
    ["ZonesController.list", "AUDITOR", true],
    ["ZonesController.create", "AUDITOR", false],
    ["PaymentsController.refund", "AUDITOR", false],
    ["AuditController.logs", "AUDITOR", true],

    // A zone officer runs kerb operations; money and partners are not theirs.
    ["ZonesController.changeStatus", "ZONE_OFFICER", true],
    ["ZonesController.create", "ZONE_OFFICER", false],
    ["PaymentsController.refund", "ZONE_OFFICER", false],
    ["SettlementsController.approve", "ZONE_OFFICER", false],
    ["UsersController.create", "ZONE_OFFICER", false],

    // A vendor sees its own operation and manages its own staff.
    ["AttendantsController.create", "VENDOR", true],
    ["AuditController.logs", "VENDOR", false],
    ["SettlementsController.approve", "VENDOR", false],

    // An attendant works the kerb and reads nothing else.
    ["ZonesController.list", "ATTENDANT", true],
    ["PaymentsController.list", "ATTENDANT", false],
    ["AuditController.logs", "ATTENDANT", false],

    // The line between an administrator and the platform owner.
    ["UsersController.create", "ADMIN", true],
    ["SettingsController.setConfig", "ADMIN", false],
    ["SettingsController.setConfig", "SUPER_ADMIN", true],
    ["SettingsController.upsertPage", "ADMIN", true],
  ];

  it.each(CASES)("%s for %s → %s", async (routeId, roleCode, allowed) => {
    expect(await verdict(guard, route(routeId), principal(roleCode))).toBe(allowed);
  });
});

describe("the shape of the matrix", () => {
  it("covers the whole surface, not a corner of it", () => {
    const decisions = SEEDED_ROLES.length * PERMISSIONED.length;
    expect(decisions).toBeGreaterThan(1000);
  });

  it("gives a citizen nothing in the portal", async () => {
    const guard = new RbacGuard(new Reflector(), seededRolesService());
    const results = await Promise.all(
      PERMISSIONED.map((r) => verdict(guard, r, principal("CITIZEN"))),
    );
    // The strongest single statement this file makes: the public app's role
    // cannot call one permissioned route in the entire API.
    expect(results.filter(Boolean)).toEqual([]);
  });

  it("gives a super admin everything", async () => {
    const guard = new RbacGuard(new Reflector(), seededRolesService());
    const results = await Promise.all(
      PERMISSIONED.map((r) => verdict(guard, r, principal("SUPER_ADMIN"))),
    );
    expect(results.filter((ok) => !ok)).toEqual([]);
  });
});

// -------------------------------------------------------------- /auth/me

/**
 * `GET /auth/me` is where the portal learns what it may render.
 *
 * `/rbac/matrix` is itself behind `user.manage`, so for every role except the
 * two that can edit roles this response is the only source. If `permissions`
 * ever goes missing the front end sees `undefined`, renders nothing, and every
 * screen looks like a permissions failure — or, depending on how it is read,
 * renders everything and lets the API do the refusing in a red toast.
 */
describe("what GET /auth/me tells the caller", () => {
  function makeAuthService(role: string) {
    const prisma = {
      user: {
        findUniqueOrThrow: async () => ({
          id: `usr_${role.toLowerCase()}`,
          name: role,
          email: `${role.toLowerCase()}@kmc.gov.in`,
          phone: null,
          role,
          status: "ACTIVE",
          twoFactorEnabled: false,
          lastLoginAt: null,
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
        }),
      },
    };
    const service = new AuthService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      seededRolesService(),
    );
    return { service, user: principal(role) };
  }

  it("gives a super admin the whole catalogue", async () => {
    const { service, user } = makeAuthService("SUPER_ADMIN");
    const me = await service.me(user);

    // Its stored list is empty; unrestricted has to be expressed as a list or
    // the portal would draw an empty sidebar for the most privileged account.
    expect([...me.permissions].sort()).toEqual([...PERMISSIONS].sort());
    expect(me.isSuperuser).toBe(true);
    expect(me.isZoneScoped).toBe(false);
  });

  it("gives an auditor exactly its eight grants", async () => {
    const { service, user } = makeAuthService("AUDITOR");
    const me = await service.me(user);

    expect(me.permissions).toEqual([
      "audit.read", "payment.read", "report.generate", "session.read",
      "settlement.read", "tariff.read", "vendor.read", "zone.read",
    ]);
    expect(me.permissions).toHaveLength(8);
    expect(me.isSuperuser).toBe(false);
  });

  it("marks a zone officer as scoped so the portal knows to say so", async () => {
    const { service, user } = makeAuthService("ZONE_OFFICER");
    const me = await service.me(user);

    expect(me.isZoneScoped).toBe(true);
    expect(me.permissions).toHaveLength(7);
  });

  it("gives a citizen an empty list, and an empty list is not a missing field", async () => {
    const { service, user } = makeAuthService("CITIZEN");
    const me = await service.me(user);

    // The distinction the front end depends on: `[]` means "you may do nothing
    // in the portal", `undefined` would mean "this API did not tell you", and a
    // client that treats them alike is one deploy away from either extreme.
    expect(me.permissions).toEqual([]);
    expect(me).toHaveProperty("permissions");
    expect(me.permissions).not.toBeUndefined();
    expect(Array.isArray(me.permissions)).toBe(true);
  });

  it("agrees with the guard, role for role", async () => {
    const guard = new RbacGuard(new Reflector(), seededRolesService());
    const zoneWrite = route("ZonesController.create");
    expect(zoneWrite.permissions).toEqual(["zone.write"]);

    for (const role of SEEDED_ROLES) {
      const { service, user } = makeAuthService(role.code);
      const me = await service.me(user);
      // What the portal draws and what the API allows must be one answer.
      expect(me.permissions.includes("zone.write")).toBe(
        await verdict(guard, zoneWrite, user),
      );
    }
  });
});

// ------------------------------------------------- conformance with the DB

/**
 * The grants above are a copy. This is the check that it is a faithful one.
 *
 * It needs a database, so it runs where there is one — locally, and against the
 * seeded scratch database — and stands aside in CI, which holds no secrets.
 */
describe.skipIf(!process.env.DATABASE_URL)("the seeded roles in the database", () => {
  it("match the grants this file asserts against", async () => {
    const { PrismaClient } = await import("@prisma/client");
    const { PrismaPg } = await import("@prisma/adapter-pg");
    // Prisma 7: the adapter carries the connection string, exactly as
    // PrismaService builds it.
    const prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
    });
    try {
      const rows = await prisma.role.findMany({ where: { isSystem: true } });
      const actual = rows
        .map((row) => ({
          code: row.code,
          isSuperuser: row.isSuperuser,
          isZoneScoped: row.isZoneScoped,
          permissions: [...row.permissions].sort(),
        }))
        .sort((a, b) => a.code.localeCompare(b.code));

      const expected = SEEDED_ROLES.map((role) => ({
        code: role.code,
        isSuperuser: role.isSuperuser,
        isZoneScoped: role.isZoneScoped,
        permissions: [...role.permissions].sort(),
      })).sort((a, b) => a.code.localeCompare(b.code));

      expect(actual).toEqual(expected);
    } finally {
      await prisma.$disconnect();
    }
  });
});
