import { describe, expect, it, vi } from "vitest";
import { IncidentStatus, MediaPurpose, SessionStatus } from "@prisma/client";

import { RetentionService, type ClassOutcome } from "../src/modules/privacy/retention.service";
import { cutoffFor, periodDays, flag } from "../src/modules/privacy/retention.policy";

/**
 * The purge is the only thing on this platform whose ordinary outcome is that
 * data ceases to exist. Everything below is a boundary: the day either side of
 * a cutoff, the record somebody is still arguing about, the run that must not
 * delete, and the second run that must find nothing left.
 *
 * These use a small in-memory Prisma rather than `vi.fn()` returning canned
 * rows, and that is the whole point of the file. A mock that ignores the
 * `where` clause would pass every test here while the real service deleted the
 * wrong century of records — the filters *are* the safety, so the filters are
 * what get evaluated.
 */

// ------------------------------------------------------------ a tiny Prisma

type Row = Record<string, any>;
type Relations = Record<string, (row: Row) => Row[]>;

/** The handful of Prisma operators this service actually uses. */
function matchValue(value: unknown, condition: unknown): boolean {
  if (condition === null) return value === null || value === undefined;
  if (condition instanceof Date) return (value as Date)?.getTime?.() === condition.getTime();
  if (typeof condition === "object" && condition !== null) {
    for (const [op, arg] of Object.entries(condition)) {
      switch (op) {
        case "lt":
          if (!(value != null && (value as never) < (arg as never))) return false;
          break;
        case "gte":
          if (!(value != null && (value as never) >= (arg as never))) return false;
          break;
        case "in":
          if (!(arg as unknown[]).includes(value)) return false;
          break;
        case "not":
          if (arg === null) {
            if (value === null || value === undefined) return false;
          } else if (matchValue(value, arg)) return false;
          break;
        case "startsWith":
          if (!String(value).startsWith(arg as string)) return false;
          break;
        case "hasSome":
          if (!((value as unknown[]) ?? []).some((v) => (arg as unknown[]).includes(v))) return false;
          break;
        default:
          throw new Error(`The test Prisma does not implement the "${op}" operator`);
      }
    }
    return true;
  }
  return value === condition;
}

function matches(row: Row, where: Row | undefined, rel: Relations): boolean {
  if (!where) return true;
  for (const [key, condition] of Object.entries(where)) {
    if (key === "AND") {
      if (!(condition as Row[]).every((c) => matches(row, c, rel))) return false;
      continue;
    }
    if (key === "OR") {
      if (!(condition as Row[]).some((c) => matches(row, c, rel))) return false;
      continue;
    }
    if (rel[key]) {
      const children = rel[key](row);
      const spec = condition as { some?: Row; none?: Row };
      if (spec.some && !children.some((c) => matches(c, spec.some, {}))) return false;
      if (spec.none && children.some((c) => matches(c, spec.none!, {}))) return false;
      continue;
    }
    if (!matchValue(row[key], condition)) return false;
  }
  return true;
}

function project(row: Row, select?: Record<string, boolean>): Row {
  if (!select) return { ...row };
  return Object.fromEntries(Object.keys(select).map((k) => [k, row[k] ?? null]));
}

/** One table. `rows` is mutated in place so deletes are visible to later reads. */
function table(rows: Row[], rel: Relations = {}) {
  return {
    rows,
    count: async ({ where }: { where?: Row } = {}) => rows.filter((r) => matches(r, where, rel)).length,
    findMany: async ({ where, take, select }: { where?: Row; take?: number; select?: Row } = {}) => {
      let found = rows.filter((r) => matches(r, where, rel));
      if (take !== undefined) found = found.slice(0, take);
      return found.map((r) => project(r, select as Record<string, boolean> | undefined));
    },
    findUnique: async ({ where }: { where: Row }) => {
      const [key, value] = Object.entries(where)[0];
      return rows.find((r) => r[key] === value) ?? null;
    },
    deleteMany: async ({ where }: { where?: Row } = {}) => {
      const keep = rows.filter((r) => !matches(r, where, rel));
      const count = rows.length - keep.length;
      rows.splice(0, rows.length, ...keep);
      return { count };
    },
    updateMany: async ({ where, data }: { where?: Row; data: Row }) => {
      let count = 0;
      for (const row of rows) {
        if (matches(row, where, rel)) {
          Object.assign(row, data);
          count++;
        }
      }
      return { count };
    },
  };
}

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-09-04T02:30:00.000Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY);

interface World {
  config?: { key: string; value: unknown }[];
  media?: Row[];
  sessions?: Row[];
  incidents?: Row[];
  authEvents?: Row[];
  otp?: Row[];
}

/** Retention on, so a test that means to delete actually deletes. */
const LIVE = [
  { key: "retention.dryRun", value: false },
  { key: "retention.legalHold", value: false },
];

function makeService(world: World = {}) {
  const sessions = world.sessions ?? [];
  const incidents = world.incidents ?? [];

  const db = {
    systemConfig: table(world.config ?? LIVE),
    media: table(world.media ?? []),
    parkingSession: table(sessions, {
      incidents: (session) => incidents.filter((i) => i.sessionId === session.id),
    }),
    incident: table(incidents),
    otpRequest: table(world.otp ?? []),
    notification: table([]),
    loginSession: table([]),
    authEvent: table(world.authEvents ?? []),
    reportJob: table([]),
    auditLog: table([]),
  };

  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  const media = { discardObjects: vi.fn().mockResolvedValue(0) };

  const service = new RetentionService(db as never, audit as never, media as never);
  return { service, db, audit, media };
}

const outcomeFor = (result: { classes: ClassOutcome[] }, code: string): ClassOutcome =>
  result.classes.find((c) => c.code === code)!;

/** An evidence photograph and the concluded session it belongs to. */
function evidence(id: string, ageDays: number, sessionOverrides: Row = {}) {
  return {
    media: {
      id,
      key: `session_evidence_start/${id}.jpg`,
      bucket: "kmcp-media",
      purpose: MediaPurpose.SESSION_EVIDENCE_START,
      createdAt: daysAgo(ageDays),
    },
    session: {
      id: `ses_${id}`,
      status: SessionStatus.COMPLETED,
      startAt: daysAgo(ageDays),
      endAt: daysAgo(ageDays),
      startLat: 22.57,
      startLng: 88.36,
      endLat: 22.57,
      endLng: 88.36,
      evidenceStartMediaId: id,
      evidenceEndMediaId: null,
      ...sessionOverrides,
    },
  };
}

// ------------------------------------------------------------------- the cutoff

describe("the window", () => {
  it("leaves a photograph taken inside the ninety days alone", async () => {
    const inside = evidence("med_inside", 89);
    const { service, db } = makeService({
      media: [inside.media],
      sessions: [inside.session],
    });

    const result = await service.purge({ now: NOW });

    // 89 days old against a 90-day period. One day the wrong way here is the
    // difference between honouring the published notice and breaking it.
    expect(outcomeFor(result, "evidenceMedia").pastCutoff).toBe(0);
    expect(db.media.rows).toHaveLength(1);
  });

  it("destroys one taken the day after the period ends", async () => {
    const outside = evidence("med_outside", 91);
    const { service, db, media } = makeService({
      media: [outside.media],
      sessions: [outside.session],
    });

    const result = await service.purge({ now: NOW });

    expect(outcomeFor(result, "evidenceMedia").purged).toBe(1);
    expect(db.media.rows).toHaveLength(0);
    // The bytes as well as the row. A deleted row over a surviving object is a
    // photograph nobody can find and nobody has destroyed.
    expect(media.discardObjects).toHaveBeenCalledWith([
      expect.objectContaining({ key: outside.media.key }),
    ]);
  });

  it("clears the session's reference so nothing points at a deleted file", async () => {
    const outside = evidence("med_ref", 120);
    const { service, db } = makeService({ media: [outside.media], sessions: [outside.session] });

    await service.purge({ now: NOW });

    expect(db.parkingSession.rows[0].evidenceStartMediaId).toBeNull();
  });

  it("honours a period the authority has changed", async () => {
    const photo = evidence("med_conf", 40);
    const { service, db } = makeService({
      // Thirty days rather than the seeded ninety. The decision is the
      // authority's, and the engine has to actually read it.
      config: [...LIVE, { key: "retention.evidenceMediaDays", value: 30 }],
      media: [photo.media],
      sessions: [photo.session],
    });

    await service.purge({ now: NOW });
    expect(db.media.rows).toHaveLength(0);
  });
});

// -------------------------------------------------------------- legal holds

describe("what the purge refuses to touch", () => {
  it("keeps evidence on a disputed session past its retention date", async () => {
    const disputed = evidence("med_disputed", 400, { status: SessionStatus.DISPUTED });
    const { service, db } = makeService({ media: [disputed.media], sessions: [disputed.session] });

    const result = await service.purge({ now: NOW });

    const outcome = outcomeFor(result, "evidenceMedia");
    expect(outcome.pastCutoff).toBe(1);
    expect(outcome.heldBack).toBe(1);
    expect(outcome.purged).toBe(0);
    // A record under dispute is the one record that must outlive the schedule.
    expect(db.media.rows).toHaveLength(1);
  });

  it("keeps evidence on a session that has not concluded", async () => {
    const live = evidence("med_active", 400, { status: SessionStatus.ACTIVE, endAt: null });
    const { service, db } = makeService({ media: [live.media], sessions: [live.session] });

    await service.purge({ now: NOW });
    expect(db.media.rows).toHaveLength(1);
  });

  it("keeps evidence on a settled session that an open incident refers to", async () => {
    const settled = evidence("med_incident", 400);
    const { service, db } = makeService({
      media: [settled.media],
      sessions: [settled.session],
      // The session itself is perfectly closed. Somebody's complaint about it
      // is not, and that complaint will be decided on this photograph.
      incidents: [
        { id: "inc_1", sessionId: settled.session.id, status: IncidentStatus.IN_PROGRESS, mediaIds: [] },
      ],
    });

    const result = await service.purge({ now: NOW });

    expect(outcomeFor(result, "evidenceMedia").heldBack).toBe(1);
    expect(db.media.rows).toHaveLength(1);
  });

  it("keeps a photograph attached directly to an open incident", async () => {
    const loose = evidence("med_attached", 400);
    const { service, db } = makeService({
      media: [loose.media],
      sessions: [loose.session],
      // No session link at all — the incident carries the media id itself.
      incidents: [
        { id: "inc_2", sessionId: null, status: IncidentStatus.OPEN, mediaIds: ["med_attached"] },
      ],
    });

    await service.purge({ now: NOW });
    expect(db.media.rows).toHaveLength(1);
  });

  it("releases it once the incident is resolved", async () => {
    const settled = evidence("med_resolved", 400);
    const { service, db } = makeService({
      media: [settled.media],
      sessions: [settled.session],
      incidents: [
        { id: "inc_3", sessionId: settled.session.id, status: IncidentStatus.RESOLVED, mediaIds: [] },
      ],
    });

    await service.purge({ now: NOW });
    expect(db.media.rows).toHaveLength(0);
  });

  it("suspends every class while a blanket legal hold is in force", async () => {
    const old = evidence("med_hold", 400);
    const { service, db } = makeService({
      config: [
        { key: "retention.dryRun", value: false },
        { key: "retention.legalHold", value: true },
      ],
      media: [old.media],
      sessions: [old.session],
      otp: [{ id: "otp_1", createdAt: daysAgo(300) }],
    });

    const result = await service.purge({ now: NOW });

    expect(result.legalHold).toBe(true);
    expect(result.totalPurged).toBe(0);
    expect(db.media.rows).toHaveLength(1);
    expect(db.otpRequest.rows).toHaveLength(1);
    // The counting still happens: the backlog accumulating under the hold is
    // the cost of the hold and should be visible before it lifts.
    expect(outcomeFor(result, "otpRequests").pastCutoff).toBe(1);
  });
});

// ------------------------------------------------------------------ dry run

describe("the dry run", () => {
  it("reports what it would destroy and destroys nothing", async () => {
    const old = evidence("med_dry", 400);
    const { service, db, media } = makeService({
      // The seeded default. A fresh deployment must not start deleting before
      // the authority has confirmed the periods.
      config: [{ key: "retention.dryRun", value: true }],
      media: [old.media],
      sessions: [old.session],
      otp: [{ id: "otp_dry", createdAt: daysAgo(30) }],
    });

    const result = await service.purge({ now: NOW });

    expect(result.dryRun).toBe(true);
    expect(result.totalPurged).toBe(0);
    expect(outcomeFor(result, "evidenceMedia").pastCutoff).toBe(1);
    expect(outcomeFor(result, "otpRequests").pastCutoff).toBe(1);
    expect(db.media.rows).toHaveLength(1);
    expect(db.otpRequest.rows).toHaveLength(1);
    expect(media.discardObjects).not.toHaveBeenCalled();
  });

  it("is the default when nothing is configured at all", async () => {
    const { service } = makeService({ config: [], otp: [{ id: "otp_x", createdAt: daysAgo(30) }] });

    const result = await service.purge({ now: NOW });
    expect(result.dryRun).toBe(true);
  });

  it("previews without deleting even when the purge is live", async () => {
    const old = evidence("med_preview", 400);
    const { service, db } = makeService({ media: [old.media], sessions: [old.session] });

    const result = await service.preview("req_1");

    expect(result.preview).toBe(true);
    expect(result.totalPurged).toBe(0);
    expect(db.media.rows).toHaveLength(1);
  });
});

// -------------------------------------------------------------- idempotency

describe("running it twice", () => {
  it("finds nothing left on the second pass", async () => {
    const old = evidence("med_twice", 400);
    const { service, db } = makeService({
      media: [old.media],
      sessions: [old.session],
      otp: [{ id: "otp_a", createdAt: daysAgo(30) }],
    });

    const first = await service.purge({ now: NOW });
    const second = await service.purge({ now: NOW });

    expect(first.totalPurged).toBeGreaterThan(0);
    // A duplicate cron delivery, a retry, an operator running it by hand — all
    // of them have to be safe, and the only thing that makes them safe is that
    // the second run genuinely matches nothing.
    expect(second.totalPurged).toBe(0);
    expect(db.media.rows).toHaveLength(0);
  });

  it("does not re-null coordinates it has already nulled", async () => {
    const { service, db } = makeService({
      sessions: [
        {
          id: "ses_geo",
          status: SessionStatus.COMPLETED,
          startAt: daysAgo(200),
          endAt: daysAgo(200),
          startLat: 22.57,
          startLng: 88.36,
          endLat: 22.58,
          endLng: 88.37,
          evidenceStartMediaId: null,
          evidenceEndMediaId: null,
        },
      ],
    });

    const first = await service.purge({ now: NOW });
    const second = await service.purge({ now: NOW });

    expect(outcomeFor(first, "sessionGeo").purged).toBe(1);
    expect(outcomeFor(second, "sessionGeo").pastCutoff).toBe(0);
    // The financial row survives; only the movement trace is gone.
    expect(db.parkingSession.rows[0]).toMatchObject({
      id: "ses_geo",
      status: SessionStatus.COMPLETED,
      startLat: null,
      endLng: null,
    });
  });

  it("holds the coordinates of a session with an open complaint", async () => {
    const { service, db } = makeService({
      sessions: [
        {
          id: "ses_held",
          status: SessionStatus.COMPLETED,
          startAt: daysAgo(200),
          endAt: daysAgo(200),
          startLat: 22.57,
          startLng: 88.36,
          endLat: null,
          endLng: null,
          evidenceStartMediaId: null,
          evidenceEndMediaId: null,
        },
      ],
      incidents: [{ id: "inc_geo", sessionId: "ses_held", status: IncidentStatus.OPEN, mediaIds: [] }],
    });

    const result = await service.purge({ now: NOW });

    expect(outcomeFor(result, "sessionGeo")).toMatchObject({ heldBack: 1, purged: 0 });
    expect(db.parkingSession.rows[0].startLat).toBe(22.57);
  });
});

// --------------------------------------------------------------- the bound

describe("the per-run bound", () => {
  it("stops at the configured limit and says there is more to come", async () => {
    const rows = Array.from({ length: 25 }, (_, i) => ({
      id: `otp_${i}`,
      createdAt: daysAgo(30),
    }));
    const { service, db } = makeService({
      config: [...LIVE, { key: "retention.maxRowsPerClass", value: 10 }],
      otp: rows,
    });

    const first = await service.purge({ now: NOW });
    const outcome = outcomeFor(first, "otpRequests");

    expect(outcome.pastCutoff).toBe(25);
    expect(outcome.purged).toBe(10);
    expect(outcome.moreRemaining).toBe(true);
    expect(db.otpRequest.rows).toHaveLength(15);

    // The backlog is eaten across runs rather than attempted in one that would
    // time out half-way through deleting.
    await service.purge({ now: NOW });
    await service.purge({ now: NOW });
    expect(db.otpRequest.rows).toHaveLength(0);
  });
});

// ------------------------------------------------------------------- audit

describe("proving it happened", () => {
  it("writes a summary row even when nothing was destroyed", async () => {
    const { service, audit } = makeService({ config: [] });

    await service.purge({ now: NOW });

    const actions = audit.record.mock.calls.map((c) => c[0].action);
    // The row that shows the sweep is alive on the days there was nothing to
    // do — which is most days, and is exactly what has to be demonstrable.
    expect(actions).toContain("RETENTION_SWEEP");
    expect(actions).not.toContain("RETENTION_PURGE");
  });

  it("records the class and the count, and never the data", async () => {
    const old = evidence("med_audit", 400);
    const { service, audit } = makeService({ media: [old.media], sessions: [old.session] });

    await service.purge({ now: NOW });

    const entry = audit.record.mock.calls
      .map((c) => c[0])
      .find((e) => e.action === "RETENTION_PURGE" && e.entityId === "evidenceMedia");

    expect(entry).toMatchObject({
      entity: "RetentionClass",
      after: expect.objectContaining({ rowsPurged: 1, retentionDays: 90 }),
    });
    // An audit trail that quoted what it destroyed would have re-created it —
    // and this row is kept for seven years.
    const serialised = JSON.stringify(entry);
    expect(serialised).not.toContain(old.media.key);
    expect(serialised).not.toContain(old.session.id);
  });
});

// ------------------------------------------------------- reading the config

describe("reading a period out of configuration", () => {
  it("falls back rather than trusting nonsense", () => {
    // A NaN cutoff compares false against every date, which in a filter that
    // decides what to delete is either "everything" or "nothing" depending on
    // which way the comparison falls. Neither is left to chance.
    expect(periodDays("ninety", 90)).toBe(90);
    expect(periodDays(null, 90)).toBe(90);
    expect(periodDays(undefined, 90)).toBe(90);
    expect(periodDays({}, 90)).toBe(90);
    // Zero days means "destroy everything ever recorded". Not a setting anyone
    // reaches for by accident, so it is refused.
    expect(periodDays(0, 90)).toBe(90);
    expect(periodDays(-5, 90)).toBe(90);
  });

  it("accepts a real number, including one that arrived as a string", () => {
    expect(periodDays(30, 90)).toBe(30);
    expect(periodDays("30", 90)).toBe(30);
    expect(periodDays(30.7, 90)).toBe(30);
  });

  it("reads a flag conservatively", () => {
    expect(flag(true, false)).toBe(true);
    expect(flag("true", false)).toBe(true);
    expect(flag("false", true)).toBe(false);
    // Anything unrecognised keeps the safe default rather than guessing.
    expect(flag("yes", true)).toBe(true);
    expect(flag(undefined, true)).toBe(true);
  });

  it("counts back from now, not forward", () => {
    expect(cutoffFor(90, NOW).getTime()).toBe(NOW.getTime() - 90 * DAY);
  });
});
