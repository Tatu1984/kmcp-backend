import { Injectable, Logger } from "@nestjs/common";
import { IncidentStatus, MediaPurpose, SessionStatus } from "@prisma/client";

import { PrismaService } from "@/prisma/prisma.service";
import { AuditService } from "@/common/services/audit.service";
import { MediaService } from "@/modules/media/media.service";
import {
  BATCH_KEY,
  DEFAULT_BATCH,
  DRY_RUN_KEY,
  LEGAL_HOLD_KEY,
  RETENTION_CLASSES,
  cutoffFor,
  flag,
  periodDays,
  type RetentionClass,
} from "./retention.policy";

/** What one class did, or would have done. */
export interface ClassOutcome {
  code: string;
  label: string;
  days: number;
  cutoff: string;
  /** Rows older than the cutoff, before any hold is considered. */
  pastCutoff: number;
  /** Rows this run declined to touch because something still needs them. */
  heldBack: number;
  /** Rows destroyed or redacted. Zero on a dry run, whatever the count above. */
  purged: number;
  /** True when the batch bound stopped this run short of the backlog. */
  moreRemaining: boolean;
}

export interface PurgeOutcome {
  startedAt: string;
  finishedAt: string;
  /** True when nothing was destroyed because the platform is in report-only mode. */
  dryRun: boolean;
  /** True when a blanket legal hold suspended the sweep entirely. */
  legalHold: boolean;
  /** True when the caller asked for a count and nothing else. */
  preview: boolean;
  batchLimit: number;
  classes: ClassOutcome[];
  totalPurged: number;
}

/** Sessions whose evidence and coordinates are still doing a job. */
const UNCONCLUDED: SessionStatus[] = [
  SessionStatus.ACTIVE,
  SessionStatus.OVERSTAY,
  SessionStatus.DISPUTED,
];

/** An incident in either of these is somebody's open complaint. */
const OPEN_INCIDENT: IncidentStatus[] = [IncidentStatus.OPEN, IncidentStatus.IN_PROGRESS];

const EVIDENCE: MediaPurpose[] = [
  MediaPurpose.SESSION_EVIDENCE_START,
  MediaPurpose.SESSION_EVIDENCE_END,
];

/**
 * How many evidence files one erasure may destroy in its own request.
 *
 * Object deletions are one round trip each, and this runs inside a function
 * with a thirty-second ceiling. Far above any real citizen's parking history;
 * see `destroyEvidence` for what happens in the case it is not.
 */
const ERASURE_FILE_LIMIT = 400;

/**
 * The engine that makes the published privacy notice true.
 *
 * The notice at CMS slug `kmcp-privacy` tells citizens their evidence is
 * "retained for ninety days and then destroyed". Nothing destroyed it. This
 * does — and the shape of the thing is dictated almost entirely by the fact
 * that destruction cannot be undone:
 *
 * **It reports before it acts.** Every run counts what it is about to destroy
 * and logs that count, whether or not it goes on to destroy anything. On a
 * fresh deployment `retention.dryRun` is seeded `true`, so the first weeks are
 * a report the authority reads and argues with rather than a deletion it
 * discovers afterwards.
 *
 * **It is bounded.** No run touches more than `retention.maxRowsPerClass` rows
 * of any one class. This runs inside a serverless function with a thirty-second
 * ceiling; a backlog of a million rows has to be eaten across many runs, and
 * the alternative — a pass that times out half-way through deleting — is the
 * one outcome with no clean recovery.
 *
 * **It is idempotent.** Every filter is "older than the cutoff and still
 * present", so a second run in the same minute finds nothing left and says so.
 * A duplicate cron delivery is a no-op, not a double deletion.
 *
 * **It refuses to touch anything still in use.** See `heldBack` on each class:
 * an unconcluded or disputed session, and anything an open incident points at,
 * survives its retention period. A record under dispute is the one record that
 * must outlive the schedule, because the schedule is not what a tribunal will
 * ask about.
 *
 * **Its own work is audited.** Each class that destroys anything writes an
 * audit row naming the class and the count, and every run writes a summary row
 * even when it deleted nothing — which is how the authority proves the sweep
 * has been running. Those rows record counts and never content: an audit trail
 * that quoted the personal data it had just destroyed would have re-created it.
 */
@Injectable()
export class RetentionService {
  private readonly logger = new Logger(RetentionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly media: MediaService,
  ) {}

  // ------------------------------------------------------------ configuration

  /**
   * The whole policy as the platform is currently running it.
   *
   * Read by the settings screen, so an officer can see the periods actually in
   * force rather than the numbers in a specification document. Every value is
   * resolved the same way the purge resolves it, including the fallbacks — a
   * screen that showed the seeded default while the purge used something else
   * would be worse than showing nothing.
   */
  async policy(): Promise<{
    dryRun: boolean;
    legalHold: boolean;
    batchLimit: number;
    classes: (RetentionClass & { days: number; configured: boolean })[];
  }> {
    const rows = await this.prisma.systemConfig.findMany({
      where: { key: { startsWith: "retention." } },
    });
    const byKey = new Map(rows.map((r) => [r.key, r.value as unknown]));

    return {
      dryRun: flag(byKey.get(DRY_RUN_KEY), true),
      legalHold: flag(byKey.get(LEGAL_HOLD_KEY), false),
      // Read through the same guard as a period: both are "a positive whole
      // number, or the default if the row is nonsense". A batch limit of zero
      // would silently stop the sweep doing anything at all.
      batchLimit: periodDays(byKey.get(BATCH_KEY), DEFAULT_BATCH),
      classes: RETENTION_CLASSES.map((klass) => ({
        ...klass,
        days: periodDays(byKey.get(klass.configKey), klass.defaultDays),
        // Whether the authority has actually made this decision, or is still
        // running on what the seed proposed.
        configured: byKey.has(klass.configKey),
      })),
    };
  }

  // -------------------------------------------------------------- the sweep

  /**
   * Applies every retention class once.
   *
   * `now` is injectable so the boundary cases can be tested against a fixed
   * clock. Nothing else passes it.
   */
  async purge(
    options: { requestId?: string; now?: Date; reportOnly?: boolean } = {},
  ): Promise<PurgeOutcome> {
    const now = options.now ?? new Date();
    const startedAt = now.toISOString();
    const policy = await this.policy();

    // A blanket hold does not skip the counting. The authority still wants to
    // know what is accumulating while the hold is in force — that backlog is
    // the cost of the hold, and it should be visible rather than discovered on
    // the day the hold lifts.
    const suspended = policy.dryRun || policy.legalHold || options.reportOnly === true;

    const classes: ClassOutcome[] = [];
    for (const klass of policy.classes) {
      const cutoff = cutoffFor(klass.days, now);
      try {
        const outcome = await this.runClass(klass, cutoff, policy.batchLimit, suspended);
        classes.push(outcome);
      } catch (error) {
        // One class failing must not abandon the rest. A storage outage should
        // not stop expired one-time passcodes being cleared.
        this.logger.error(
          `Retention class ${klass.code} failed; the remaining classes still ran.`,
          error instanceof Error ? error.stack : String(error),
        );
        classes.push({
          code: klass.code,
          label: klass.label,
          days: klass.days,
          cutoff: cutoff.toISOString(),
          pastCutoff: 0,
          heldBack: 0,
          purged: 0,
          moreRemaining: true,
        });
      }
    }

    const totalPurged = classes.reduce((sum, c) => sum + c.purged, 0);
    const outcome: PurgeOutcome = {
      startedAt,
      finishedAt: new Date().toISOString(),
      dryRun: policy.dryRun,
      legalHold: policy.legalHold,
      preview: options.reportOnly === true,
      batchLimit: policy.batchLimit,
      classes,
      totalPurged,
    };

    await this.recordAudit(outcome, options.requestId);
    return outcome;
  }

  /**
   * What the next real purge would destroy, without destroying it.
   *
   * The same code path as `purge`, with destruction forced off rather than read
   * from configuration — an officer about to turn `retention.dryRun` off should
   * be able to see the consequence without performing it. A separate
   * count-only implementation would eventually disagree with the one that
   * deletes, and would disagree silently.
   */
  preview(requestId?: string): Promise<PurgeOutcome> {
    return this.purge({ requestId, reportOnly: true });
  }

  private async runClass(
    klass: RetentionClass & { days: number },
    cutoff: Date,
    limit: number,
    suspended: boolean,
  ): Promise<ClassOutcome> {
    const result = await this.execute(klass.code, cutoff, limit, suspended);

    // The dry-run count, logged before anything is destroyed and logged again
    // on every run afterwards. An operator watching the logs sees the number
    // coming for days before it is acted on.
    this.logger.log(
      `${klass.code}: ${result.pastCutoff} row(s) older than ${cutoff.toISOString()} ` +
        `(period ${klass.days}d), ${result.heldBack} held back, ` +
        `${suspended ? `${result.purged} would be purged — reporting only` : `${result.purged} purged`}`,
    );

    return {
      code: klass.code,
      label: klass.label,
      days: klass.days,
      cutoff: cutoff.toISOString(),
      pastCutoff: result.pastCutoff,
      heldBack: result.heldBack,
      // On a suspended run the executor still worked out what it *would* do, so
      // the count is honest — but nothing was destroyed, so nothing is claimed.
      purged: suspended ? 0 : result.purged,
      moreRemaining: result.pastCutoff > result.heldBack + result.purged,
    };
  }

  private execute(
    code: string,
    cutoff: Date,
    limit: number,
    suspended: boolean,
  ): Promise<{ pastCutoff: number; heldBack: number; purged: number }> {
    switch (code) {
      case "otpRequests":
        return this.purgeOtpRequests(cutoff, limit, suspended);
      case "notifications":
        return this.purgeNotifications(cutoff, limit, suspended);
      case "loginSessions":
        return this.purgeLoginSessions(cutoff, limit, suspended);
      case "authEvents":
        return this.purgeAuthEvents(cutoff, limit, suspended);
      case "reportExports":
        return this.purgeReportExports(cutoff, limit, suspended);
      case "sessionGeo":
        return this.purgeSessionGeo(cutoff, limit, suspended);
      case "evidenceMedia":
        return this.purgeEvidenceMedia(cutoff, limit, suspended);
      case "auditLogs":
        return this.purgeAuditLogs(cutoff, limit, suspended);
      default:
        // Unreachable while the catalogue and this switch agree. Reported
        // rather than thrown, so a half-finished class cannot stop the sweep.
        this.logger.error(`No executor for retention class ${code}; nothing was purged for it.`);
        return Promise.resolve({ pastCutoff: 0, heldBack: 0, purged: 0 });
    }
  }

  // ----------------------------------------------------------- the executors

  private async purgeOtpRequests(cutoff: Date, limit: number, suspended: boolean) {
    const where = { createdAt: { lt: cutoff } };
    const pastCutoff = await this.prisma.otpRequest.count({ where });
    const ids = await this.take(
      this.prisma.otpRequest.findMany({ where, select: { id: true }, take: limit }),
    );
    if (!suspended && ids.length > 0) {
      await this.prisma.otpRequest.deleteMany({ where: { id: { in: ids } } });
    }
    return { pastCutoff, heldBack: 0, purged: ids.length };
  }

  private async purgeNotifications(cutoff: Date, limit: number, suspended: boolean) {
    const where = { createdAt: { lt: cutoff } };
    const pastCutoff = await this.prisma.notification.count({ where });
    const ids = await this.take(
      this.prisma.notification.findMany({ where, select: { id: true }, take: limit }),
    );
    if (!suspended && ids.length > 0) {
      await this.prisma.notification.deleteMany({ where: { id: { in: ids } } });
    }
    return { pastCutoff, heldBack: 0, purged: ids.length };
  }

  /**
   * Only sessions that have already ended. `expiresAt` rather than `createdAt`
   * is the age that matters — a thirty-day refresh session created 200 days ago
   * may still be live, and signing someone out is not this sweep's job.
   */
  private async purgeLoginSessions(cutoff: Date, limit: number, suspended: boolean) {
    const where = { expiresAt: { lt: cutoff } };
    const pastCutoff = await this.prisma.loginSession.count({ where });
    const ids = await this.take(
      this.prisma.loginSession.findMany({ where, select: { id: true }, take: limit }),
    );
    if (!suspended && ids.length > 0) {
      await this.prisma.loginSession.deleteMany({ where: { id: { in: ids } } });
    }
    return { pastCutoff, heldBack: 0, purged: ids.length };
  }

  private async purgeAuthEvents(cutoff: Date, limit: number, suspended: boolean) {
    const where = { createdAt: { lt: cutoff } };
    const pastCutoff = await this.prisma.authEvent.count({ where });
    const ids = await this.take(
      this.prisma.authEvent.findMany({ where, select: { id: true }, take: limit }),
    );
    if (!suspended && ids.length > 0) {
      await this.prisma.authEvent.deleteMany({ where: { id: { in: ids } } });
    }
    return { pastCutoff, heldBack: 0, purged: ids.length };
  }

  /**
   * Report exports, file and job together.
   *
   * A report is a bulk extract — plates, times, amounts — written to the bucket
   * so an officer can download it once. Keeping it afterwards is pure exposure:
   * the underlying records are untouched and the report can be regenerated
   * whenever anyone actually wants it again.
   */
  private async purgeReportExports(cutoff: Date, limit: number, suspended: boolean) {
    const mediaWhere = { purpose: MediaPurpose.REPORT_EXPORT, createdAt: { lt: cutoff } };
    const jobWhere = { createdAt: { lt: cutoff } };

    const [mediaCount, jobCount] = await Promise.all([
      this.prisma.media.count({ where: mediaWhere }),
      this.prisma.reportJob.count({ where: jobWhere }),
    ]);

    const files = await this.prisma.media.findMany({
      where: mediaWhere,
      select: { id: true, key: true, bucket: true },
      take: limit,
    });
    // Whatever allowance the files left over. The bound is per class, not per
    // table, so a large backlog of files does not also become a large backlog
    // of job rows deleted in the same breath.
    const jobs = await this.take(
      this.prisma.reportJob.findMany({
        where: jobWhere,
        select: { id: true },
        take: Math.max(0, limit - files.length),
      }),
    );

    if (!suspended) {
      if (files.length > 0) {
        await this.media.discardObjects(files);
        await this.prisma.media.deleteMany({ where: { id: { in: files.map((f) => f.id) } } });
      }
      if (jobs.length > 0) {
        await this.prisma.reportJob.deleteMany({ where: { id: { in: jobs } } });
      }
    }

    return {
      pastCutoff: mediaCount + jobCount,
      heldBack: 0,
      purged: files.length + jobs.length,
    };
  }

  /**
   * The coordinates on a concluded session, and nothing else on it.
   *
   * This is the class where the distinction between erasure and retention is
   * clearest. The session row is a financial record: it carries the fare, the
   * tax, the vendor and the payment it settled to, and it is not ours to
   * delete. The two GPS fixes on it are not financial at all — they exist to
   * prove the attendant stood at the kerb they billed for, and once the session
   * is concluded and undisputed they are a movement trace of a private citizen
   * serving no further purpose. So the columns are nulled and the row stays.
   *
   * Nulling is also what makes this idempotent: the filter requires at least
   * one coordinate to still be present, so a second run matches nothing.
   */
  private async purgeSessionGeo(cutoff: Date, limit: number, suspended: boolean) {
    const concluded = {
      status: { in: [SessionStatus.COMPLETED, SessionStatus.CANCELLED] },
      AND: [
        // A session that ended is aged from its end; one cancelled before it
        // ever ended is aged from its start.
        { OR: [{ endAt: { lt: cutoff } }, { endAt: null, startAt: { lt: cutoff } }] },
        {
          OR: [
            { startLat: { not: null } },
            { startLng: { not: null } },
            { endLat: { not: null } },
            { endLng: { not: null } },
          ],
        },
      ],
    };

    const [pastCutoff, heldBack] = await Promise.all([
      this.prisma.parkingSession.count({ where: concluded }),
      // A concluded session can still carry an open complaint, and the officer
      // answering it will want to know where the vehicle actually was.
      this.prisma.parkingSession.count({
        where: { ...concluded, incidents: { some: { status: { in: OPEN_INCIDENT } } } },
      }),
    ]);

    const ids = await this.take(
      this.prisma.parkingSession.findMany({
        where: { ...concluded, incidents: { none: { status: { in: OPEN_INCIDENT } } } },
        select: { id: true },
        take: limit,
      }),
    );

    if (!suspended && ids.length > 0) {
      await this.prisma.parkingSession.updateMany({
        where: { id: { in: ids } },
        data: { startLat: null, startLng: null, endLat: null, endLng: null },
      });
    }

    return { pastCutoff, heldBack, purged: ids.length };
  }

  /**
   * The photographs. The class the published notice is actually about.
   *
   * Note what this deliberately does *not* use: `MediaService.remove`, which
   * refuses outright to delete anything marked `isImmutable` — and evidence is
   * always marked immutable at upload. That refusal is right for the API route
   * it guards, where an officer deleting an inconvenient photograph is exactly
   * the thing to prevent. It is not right here. Immutability means "no one
   * edits or replaces this", not "this is kept forever"; the retention schedule
   * is the one authority that may end an evidence file's life, and it does so
   * on a published timetable rather than at somebody's discretion.
   *
   * The session's references are cleared in the same pass. A session left
   * pointing at a deleted media id would send the evidence strip in the portal
   * looking for bytes that are gone, and report that as an error rather than as
   * a photograph that reached the end of its retention.
   */
  private async purgeEvidenceMedia(cutoff: Date, limit: number, suspended: boolean) {
    const where = { purpose: { in: EVIDENCE }, createdAt: { lt: cutoff } };
    const pastCutoff = await this.prisma.media.count({ where });

    const candidates = await this.prisma.media.findMany({
      where,
      select: { id: true, key: true, bucket: true },
      take: limit,
    });
    if (candidates.length === 0) return { pastCutoff, heldBack: 0, purged: 0 };

    const ids = candidates.map((c) => c.id);
    const held = await this.heldEvidenceIds(ids);

    const purgeable = candidates.filter((c) => !held.has(c.id));

    if (!suspended && purgeable.length > 0) {
      const purgeableIds = purgeable.map((p) => p.id);

      // Storage first. A row deleted while its object survives is an orphan
      // nobody can find; an object deleted while its row survives is a broken
      // link the next run will clean up. Of the two failure modes, only the
      // first leaves personal data lying in a bucket.
      await this.media.discardObjects(purgeable);

      await this.prisma.parkingSession.updateMany({
        where: { evidenceStartMediaId: { in: purgeableIds } },
        data: { evidenceStartMediaId: null },
      });
      await this.prisma.parkingSession.updateMany({
        where: { evidenceEndMediaId: { in: purgeableIds } },
        data: { evidenceEndMediaId: null },
      });
      await this.prisma.media.deleteMany({ where: { id: { in: purgeableIds } } });
    }

    return { pastCutoff, heldBack: held.size, purged: purgeable.length };
  }

  /**
   * Which of these media ids something still needs.
   *
   * Two holds, and they are different in kind. A session that is unconcluded or
   * disputed still needs its own evidence to settle what is owed. An incident
   * in OPEN or IN_PROGRESS is somebody's live complaint, and the photographs
   * attached to it are what it will be decided on — including photographs that
   * belong to a session which is itself perfectly settled.
   */
  private async heldEvidenceIds(ids: string[]): Promise<Set<string>> {
    const [sessions, incidents] = await Promise.all([
      this.prisma.parkingSession.findMany({
        where: {
          AND: [
            {
              OR: [
                { evidenceStartMediaId: { in: ids } },
                { evidenceEndMediaId: { in: ids } },
              ],
            },
            {
              OR: [
                { status: { in: UNCONCLUDED } },
                { incidents: { some: { status: { in: OPEN_INCIDENT } } } },
              ],
            },
          ],
        },
        select: { evidenceStartMediaId: true, evidenceEndMediaId: true },
      }),
      this.prisma.incident.findMany({
        where: { status: { in: OPEN_INCIDENT }, mediaIds: { hasSome: ids } },
        select: { mediaIds: true },
      }),
    ]);

    const wanted = new Set(ids);
    const held = new Set<string>();
    for (const session of sessions) {
      for (const id of [session.evidenceStartMediaId, session.evidenceEndMediaId]) {
        if (id && wanted.has(id)) held.add(id);
      }
    }
    for (const incident of incidents) {
      for (const id of incident.mediaIds) if (wanted.has(id)) held.add(id);
    }
    return held;
  }

  private async purgeAuditLogs(cutoff: Date, limit: number, suspended: boolean) {
    const where = { createdAt: { lt: cutoff } };
    const pastCutoff = await this.prisma.auditLog.count({ where });
    const ids = await this.take(
      this.prisma.auditLog.findMany({ where, select: { id: true }, take: limit }),
    );
    if (!suspended && ids.length > 0) {
      await this.prisma.auditLog.deleteMany({ where: { id: { in: ids } } });
    }
    return { pastCutoff, heldBack: 0, purged: ids.length };
  }

  // --------------------------------------------------- erasure's use of this

  /**
   * Destroys named evidence files ahead of their retention date, subject to the
   * same holds the sweep applies.
   *
   * The caller is erasure, which is not a schedule: a citizen exercising
   * section 12 is not waiting ninety days for a photograph of their car outside
   * their house. The holds still apply, though, and for the same reason — an
   * open dispute or a live complaint is decided on these photographs, and a
   * record under dispute is precisely the one that must outlive any timetable.
   *
   * Bounded like everything else here. If a citizen has more than this many
   * evidence files the tail is left to the ordinary sweep, which will reach it
   * within the retention period; by then their identity has already been
   * severed from the sessions, so what remains is not linked to a person.
   */
  async destroyEvidence(mediaIds: string[]): Promise<{
    destroyed: number;
    heldBack: number;
    remaining: number;
  }> {
    if (mediaIds.length === 0) return { destroyed: 0, heldBack: 0, remaining: 0 };

    const considered = mediaIds.slice(0, ERASURE_FILE_LIMIT);
    const remaining = mediaIds.length - considered.length;

    const files = await this.prisma.media.findMany({
      where: { id: { in: considered }, purpose: { in: EVIDENCE } },
      select: { id: true, key: true, bucket: true },
    });
    if (files.length === 0) return { destroyed: 0, heldBack: 0, remaining };

    const held = await this.heldEvidenceIds(files.map((f) => f.id));
    const purgeable = files.filter((f) => !held.has(f.id));
    if (purgeable.length === 0) return { destroyed: 0, heldBack: held.size, remaining };

    const ids = purgeable.map((p) => p.id);
    await this.media.discardObjects(purgeable);
    await this.prisma.parkingSession.updateMany({
      where: { evidenceStartMediaId: { in: ids } },
      data: { evidenceStartMediaId: null },
    });
    await this.prisma.parkingSession.updateMany({
      where: { evidenceEndMediaId: { in: ids } },
      data: { evidenceEndMediaId: null },
    });
    await this.prisma.media.deleteMany({ where: { id: { in: ids } } });

    return { destroyed: ids.length, heldBack: held.size, remaining };
  }

  // ------------------------------------------------------------------ audit

  /**
   * The proof that destruction happened, and happened within the rules.
   *
   * Counts only. Naming the plate, the number or the file that was destroyed
   * would put the personal data back into a table with a seven-year period —
   * an audit trail that quotes what it destroyed has destroyed nothing.
   *
   * A summary row is written on every run, including runs that deleted nothing
   * at all. That is the row which shows the sweep is alive: an authority asked
   * to demonstrate that it enforces its own schedule needs evidence the job ran
   * on the days when there was nothing to do, not only on the days there was.
   */
  private async recordAudit(outcome: PurgeOutcome, requestId?: string): Promise<void> {
    for (const klass of outcome.classes) {
      if (klass.purged === 0) continue;
      await this.audit.record({
        action: "RETENTION_PURGE",
        entity: "RetentionClass",
        entityId: klass.code,
        after: {
          label: klass.label,
          retentionDays: klass.days,
          cutoff: klass.cutoff,
          rowsPurged: klass.purged,
          rowsHeldBack: klass.heldBack,
          rowsRemaining: klass.pastCutoff - klass.heldBack - klass.purged,
        },
        requestId,
      });
    }

    await this.audit.record({
      action: "RETENTION_SWEEP",
      entity: "RetentionPolicy",
      entityId: outcome.startedAt,
      after: {
        dryRun: outcome.dryRun,
        legalHold: outcome.legalHold,
        preview: outcome.preview,
        batchLimit: outcome.batchLimit,
        totalPurged: outcome.totalPurged,
        classes: outcome.classes.map((c) => ({
          code: c.code,
          days: c.days,
          pastCutoff: c.pastCutoff,
          heldBack: c.heldBack,
          purged: c.purged,
        })),
      },
      requestId,
    });
  }

  /** Unwraps a bounded `findMany({ select: { id } })` into plain ids. */
  private async take(query: Promise<{ id: string }[]>): Promise<string[]> {
    return (await query).map((row) => row.id);
  }
}
