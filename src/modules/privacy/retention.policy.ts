/**
 * What the platform keeps, for how long, and on whose authority.
 *
 * Every period below is a *default*, not a rule. The Act makes the retention
 * decision the data fiduciary's — the authority's — and the authority will
 * revise these once its records officer has read them. So each class names a
 * `SystemConfig` key, and the running period is whatever that key holds; the
 * number here is only what a fresh database is seeded with.
 *
 * The one period that is not really ours to choose is the evidence photograph.
 * The published privacy notice at CMS slug `kmcp-privacy` tells citizens their
 * evidence is "retained for ninety days and then destroyed". Until this file
 * existed nothing destroyed it, which made that sentence untrue — and a
 * published notice the platform does not honour is worse than no notice at all,
 * because it is the thing a complaint would be judged against.
 */

/** The namespace every retention key lives under. */
export const RETENTION_NAMESPACE = "retention";

/**
 * Master switch: report what would be destroyed, destroy nothing.
 *
 * Seeded `true`, and that default is deliberate. A purge is irreversible and
 * these periods are guesses until the authority has confirmed them, so a fresh
 * deployment must not start deleting the moment its first cron fires. Someone
 * with `config.write` turns it off once the numbers below have been signed off.
 */
export const DRY_RUN_KEY = "retention.dryRun";

/**
 * Suspends the whole purge, for the case the per-record holds cannot express:
 * a court order, a CAG audit, an ongoing investigation that touches records
 * nobody has enumerated yet. Blunt on purpose — a legal hold that has to be
 * described precisely before it takes effect is one that arrives too late.
 */
export const LEGAL_HOLD_KEY = "retention.legalHold";

/**
 * The most rows one class may destroy in one invocation.
 *
 * This runs in a serverless function with a thirty-second ceiling (see
 * `vercel.json`). A backlog of a million rows must therefore be eaten across
 * many runs rather than attempted in one that times out half-way — and half-way
 * through a destructive pass is exactly where you do not want to be. The sweep
 * is idempotent, so the remainder is simply picked up ten minutes later.
 */
export const BATCH_KEY = "retention.maxRowsPerClass";
export const DEFAULT_BATCH = 500;

export interface RetentionClass {
  /** Stable identifier. Appears in the audit trail, so it must not be renamed. */
  code: string;
  label: string;
  /** The `SystemConfig` key holding the period in days. */
  configKey: string;
  defaultDays: number;
  /** What is destroyed, in the words the runbook and the settings screen use. */
  covers: string;
  /** Why this period. The sentence a records officer will argue with. */
  basis: string;
  /** True when expiry destroys rows outright rather than redacting fields. */
  destroys: boolean;
}

/**
 * The classes, in the order a purge runs them.
 *
 * Cheap and unambiguous first, so that a run which exhausts its time budget has
 * already done the uncontroversial work. Evidence media is last because it is
 * the only class that also talks to object storage.
 */
export const RETENTION_CLASSES: RetentionClass[] = [
  {
    code: "otpRequests",
    label: "One-time passcodes",
    configKey: "retention.otpRequestDays",
    defaultDays: 7,
    covers: "OtpRequest rows — a mobile number and the hash of a code sent to it.",
    basis:
      "The code expires in minutes. A week is long enough to investigate a disputed sign-in " +
      "and short enough that the table is never a list of who was trying to log in last month.",
    destroys: true,
  },
  {
    code: "notifications",
    label: "Notification delivery records",
    configKey: "retention.notificationDays",
    defaultDays: 180,
    covers:
      "Notification rows across every channel, including the payload — which carries the " +
      "mobile number, the plate and the amount that were actually sent.",
    basis:
      "Six months covers a billing dispute and the window in which a citizen might ask why " +
      "they were messaged. It is also the log a breach notification would be assembled from, " +
      "which is why it outlives the message it describes.",
    destroys: true,
  },
  {
    code: "loginSessions",
    label: "Ended sign-in sessions",
    configKey: "retention.loginSessionDays",
    defaultDays: 180,
    covers: "LoginSession rows whose expiry has passed — IP, city, ISP and device fingerprint.",
    basis:
      "Matched to the sign-in event period below, because the two are read together when an " +
      "account compromise is investigated and a half-answer is worse than none.",
    destroys: true,
  },
  {
    code: "authEvents",
    label: "Sign-in activity",
    configKey: "retention.authEventDays",
    defaultDays: 180,
    covers:
      "AuthEvent rows — IP, geolocation, ISP, device fingerprint, and the precise GPS fix " +
      "captured where the user consented to one.",
    basis:
      "Security value decays fast: an unexplained login from Manila matters this month and " +
      "tells nobody anything next year. Six months spans a quarterly access review, which is " +
      "the longest cycle that actually reads this table.",
    destroys: true,
  },
  {
    code: "reportExports",
    label: "Report exports",
    configKey: "retention.reportExportDays",
    defaultDays: 30,
    covers:
      "Generated report files and the ReportJob rows that requested them. An export is a bulk " +
      "extract of plates, times and amounts sitting in a bucket long after the officer who " +
      "asked for it has read it.",
    basis:
      "A month is generous for a file whose purpose is to be downloaded once. The underlying " +
      "records are untouched, so the report can be regenerated the moment anyone needs it " +
      "again — which makes keeping the copy pure risk with no offsetting benefit.",
    destroys: true,
  },
  {
    code: "sessionGeo",
    label: "Parking session GPS traces",
    configKey: "retention.sessionGpsDays",
    defaultDays: 90,
    covers:
      "The start and end coordinates on concluded parking sessions. The session itself, its " +
      "fare and its payment are financial records and are never touched.",
    basis:
      "The coordinates exist to prove the attendant was standing at the kerb they billed for. " +
      "Once the session is concluded, undisputed and past the dispute window, they are a " +
      "movement trace of a private citizen and nothing else. Ninety days matches the evidence " +
      "photograph, because the two were captured in the same act.",
    destroys: false,
  },
  {
    code: "evidenceMedia",
    label: "Parking evidence photographs",
    configKey: "retention.evidenceMediaDays",
    defaultDays: 90,
    covers:
      "Entry and exit photographs of a vehicle at a kerb, in object storage and in the Media " +
      "table, and the references to them on the session.",
    basis:
      "Not our number to pick. The published privacy notice commits to ninety days, so this " +
      "is the platform keeping a promise the authority has already made in writing. Shortening " +
      "it is the authority's to do; lengthening it means republishing the notice first.",
    destroys: true,
  },
  {
    code: "auditLogs",
    label: "Audit trail",
    configKey: "retention.auditLogDays",
    defaultDays: 2555,
    covers: "AuditLog rows — who changed what, when, and from where.",
    basis:
      "Seven years, deliberately the longest period here. This is the trail a municipal audit, " +
      "a tax assessment and a DPDP enquiry are all answered from, including the record of this " +
      "very purge. Destroying it on a privacy rationale would destroy the evidence that the " +
      "privacy rules were followed.",
    destroys: true,
  },
];

export const RETENTION_CLASS_BY_CODE = new Map(RETENTION_CLASSES.map((c) => [c.code, c]));

/** Every config key this engine reads, for seeding and for the settings screen. */
export function retentionConfigDefaults(): { key: string; value: unknown }[] {
  return [
    ...RETENTION_CLASSES.map((c) => ({ key: c.configKey, value: c.defaultDays })),
    { key: DRY_RUN_KEY, value: true },
    { key: LEGAL_HOLD_KEY, value: false },
    { key: BATCH_KEY, value: DEFAULT_BATCH },
  ];
}

/**
 * A period read from configuration, or the default when the row is absent,
 * unparseable or nonsensical.
 *
 * A misconfigured key must never shorten a period. `{"value": "ninety"}` is
 * `NaN`, and a `NaN` cutoff compares false against every date — in a filter
 * that decides what to delete, that is either "delete nothing" or "delete
 * everything" depending on which way the comparison falls, and neither is a
 * thing to leave to chance. Zero and negatives are refused for the same reason:
 * a period of zero days means destroy everything ever recorded, which is not a
 * setting anyone reaches for by accident.
 */
export function periodDays(raw: unknown, fallback: number): number {
  const value = typeof raw === "string" ? Number(raw) : raw;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) return fallback;
  return Math.floor(value);
}

/** The instant before which a record of this class has outlived its purpose. */
export function cutoffFor(days: number, now: Date = new Date()): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

/** A boolean config value. Anything unrecognised reads as the safe default. */
export function flag(raw: unknown, fallback: boolean): boolean {
  if (typeof raw === "boolean") return raw;
  if (raw === "true") return true;
  if (raw === "false") return false;
  return fallback;
}
