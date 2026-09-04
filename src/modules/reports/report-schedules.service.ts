import { Injectable, Logger } from "@nestjs/common";
import {
  NotificationChannel,
  Prisma,
  ReportFrequency,
  ReportStatus,
  UserStatus,
  type ReportSchedule,
} from "@prisma/client";

import { PrismaService } from "@/prisma/prisma.service";
import { AppException } from "@/common/errors/app.exception";
import { AuditService } from "@/common/services/audit.service";
import { Paginated } from "@/common/interceptors/response.interceptor";
import { skipTake } from "@/common/dto/pagination.dto";
import { RolesService } from "@/common/rbac/roles.service";
import { scoped, zoneScopeOf } from "@/common/rbac/scope";
import type { AuthenticatedUser } from "@/common/decorators/auth.decorators";
import { MessagingService } from "@/modules/messaging/messaging.service";
import { isDeliverableChannel, type DeliverableChannel } from "@/modules/messaging/providers/provider.types";
import { NotificationsService } from "@/modules/notifications/notifications.service";

import { ReportsService } from "./reports.service";
import { reportLabel, type ReportKey } from "./report-types";
import {
  assertValidRecurrence,
  describeRecurrence,
  nextRunAfter,
  periodFor,
  zonedParts,
  type RecurrenceRule,
} from "./recurrence";
import type {
  CreateReportScheduleDto,
  ReportScheduleQueryDto,
  UpdateReportScheduleDto,
} from "./dto/report-schedule.dto";

type Ctx = { ip?: string; requestId?: string };

/**
 * How many schedules one sweep will run.
 *
 * A serverless function has thirty seconds (`vercel.json`) and a report is a
 * handful of queries, so ten is comfortable and a thousand is not. The cap is
 * not a limit on how many schedules the authority may have: the sweep takes the
 * oldest-due first and runs every quarter of an hour, so a backlog drains
 * across invocations instead of timing one out and rolling back the lot.
 */
const SWEEP_LIMIT = 10;

/**
 * Consecutive failures before a schedule is switched off.
 *
 * A schedule that fails does not retry inside the same sweep — it comes round
 * again at its next occurrence, which for a daily report is a day later. Three
 * of those is three days of an officer receiving nothing and, more to the
 * point, three days of the platform doing work it already knows will fail. The
 * common causes are permanent: the report was reassigned to an authority-wide
 * audience, the owner's role was narrowed, the zone was deleted. Retrying
 * forever would hide all three.
 */
const MAX_CONSECUTIVE_FAILURES = 3;

/** One schedule, as the portal renders it. */
export interface ReportScheduleView {
  id: string;
  name: string;
  type: string;
  /** The catalogue's own label for the type, resolved server-side. */
  label: string;
  frequency: ReportFrequency;
  hour: number;
  minute: number;
  weekday: number | null;
  dayOfMonth: number | null;
  timezone: string;
  /** "Every Monday at 08:00 (Asia/Kolkata)" — built once, here. */
  cadence: string;
  zoneId: string | null;
  vendorId: string | null;
  /** "The previous 7 days · Alipore Road" — the same column the job history shows. */
  paramsLabel: string;
  channels: string[];
  ownerId: string;
  ownerName: string;
  isActive: boolean;
  nextRunAt: Date;
  lastRunAt: Date | null;
  lastStatus: string | null;
  lastError: string | null;
  lastJobId: string | null;
  failureCount: number;
  /** Stated rather than left to the portal to hard-code. */
  failuresBeforePause: number;
  createdAt: Date;
  updatedAt: Date;
}

/** What one sweep did. Returned to the scheduler and written to the logs. */
export interface ScheduleSweepSummary {
  task: "report-schedules";
  /** Due at this instant, up to the per-invocation cap. */
  due: number;
  /** Of those, the ones this invocation actually claimed — see `claim`. */
  ran: number;
  succeeded: number;
  failed: number;
  deactivated: number;
  sweptAt: string;
}

/**
 * Recurring reports.
 *
 * ## A schedule is a standing instruction from one officer
 *
 * That sentence decides almost everything below. A run executes as the
 * schedule's owner — their role, their zones, their vendor — and goes through
 * `ReportsService.generate`, which is the same call the button makes and
 * carries the same authorisation gate. There is no path by which a schedule
 * produces a report its owner could not have produced by hand, which is the
 * property that matters: three of the eleven reports in the catalogue cover the
 * whole authority and are refused to a zone-scoped caller, and a schedule must
 * not become the way round that refusal.
 *
 * The gate is applied twice on purpose. Once when the schedule is written, so
 * an officer is told immediately rather than discovering in three days that
 * nothing has arrived; and once on every run, because a role can be narrowed
 * after the schedule was created and the run is the moment that actually
 * matters. The second check is not ours — it is inside `generate`, at the choke
 * point every builder is reached through.
 *
 * ## Running twice in the same window changes nothing
 *
 * Vercel Cron can deliver twice, an operator can curl the endpoint, and two
 * instances can be warm at once. Each schedule is therefore *claimed* by a
 * conditional update that matches on the `nextRunAt` the sweep read, and only
 * the update that changes a row goes on to run the report. The second caller
 * matches zero rows and moves on, exactly as the overstay sweep's update
 * matches no still-ACTIVE sessions the second time.
 */
@Injectable()
export class ReportSchedulesService {
  private readonly logger = new Logger(ReportSchedulesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly reports: ReportsService,
    private readonly messaging: MessagingService,
    private readonly notifications: NotificationsService,
    private readonly roles: RolesService,
    private readonly audit: AuditService,
  ) {}

  // ------------------------------------------------------------------ scope

  /**
   * Whose schedules this caller may see and manage.
   *
   * The same line `ReportsService.jobScopeOf` draws, and drawn here for the
   * same reason. A schedule row carries the owner's name, the report they run,
   * the zone and vendor they run it for and the hour they want it — which is a
   * description of what head office is watching. An unfiltered list would tell
   * a ward officer all of that, and hand them the ids to try against the
   * run-now route.
   *
   * So a zone-scoped caller sees only their own, and an unrestricted one sees
   * every schedule in the authority. Management follows visibility rather than
   * being narrower, and that is safe *because* a run executes as the owner: an
   * administrator pressing "run now" on an officer's schedule produces the
   * officer's report, delivered to the officer, under the officer's scope. It
   * is not a way to read anything, only a way to un-stick something.
   */
  private scopeOf(user: AuthenticatedUser): Prisma.ReportScheduleWhereInput {
    return zoneScopeOf(user) === null ? {} : { ownerId: user.id };
  }

  private async mustFind(id: string, user: AuthenticatedUser): Promise<ReportSchedule> {
    const schedule = await this.prisma.reportSchedule.findFirst({
      where: scoped<Prisma.ReportScheduleWhereInput>(this.scopeOf(user), { id }),
    });
    // Not-found rather than forbidden: a caller outside the scope should not
    // learn that the id exists.
    if (!schedule) throw AppException.notFound("report schedule");
    return schedule;
  }

  // -------------------------------------------------------------- the reads

  async list(query: ReportScheduleQueryDto, user: AuthenticatedUser): Promise<Paginated<ReportScheduleView>> {
    const where = scoped<Prisma.ReportScheduleWhereInput>(this.scopeOf(user), {
      ...(query.type ? { type: query.type } : {}),
      ...(query.isActive === undefined ? {} : { isActive: query.isActive }),
      ...(query.mine ? { ownerId: user.id } : {}),
    });

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.reportSchedule.findMany({
        where,
        // Active first, then by when they next fire: the reading order is "what
        // is about to happen", not "what was typed most recently".
        orderBy: [{ isActive: "desc" }, { nextRunAt: "asc" }],
        ...skipTake(query),
      }),
      this.prisma.reportSchedule.count({ where }),
    ]);

    return new Paginated(await this.toViews(rows), query.page, query.pageSize, total);
  }

  async findOne(id: string, user: AuthenticatedUser): Promise<ReportScheduleView> {
    return this.toView(await this.mustFind(id, user));
  }

  // ------------------------------------------------------------- the writes

  async create(
    dto: CreateReportScheduleDto,
    user: AuthenticatedUser,
    ctx: Ctx,
  ): Promise<ReportScheduleView> {
    // The owner is the authenticated account and never a field on the request.
    // A schedule runs as its owner, so an `ownerId` in the body would be a way
    // to have a report produced under a principal that sees more than you do.
    this.reports.assertMayRun(dto.type, user);

    const rule = ruleFrom(dto);
    assertValidRecurrence(rule);

    const schedule = await this.prisma.reportSchedule.create({
      data: {
        name: dto.name,
        type: dto.type,
        params: {
          zoneId: dto.zoneId ?? null,
          vendorId: dto.vendorId ?? null,
          format: dto.format,
        },
        frequency: dto.frequency,
        hour: dto.hour,
        minute: dto.minute,
        weekday: dto.frequency === ReportFrequency.WEEKLY ? (dto.weekday ?? null) : null,
        dayOfMonth: dto.frequency === ReportFrequency.MONTHLY ? (dto.dayOfMonth ?? null) : null,
        timezone: dto.timezone,
        channels: dto.channels,
        ownerId: user.id,
        isActive: dto.isActive,
        nextRunAt: nextRunAfter(rule, new Date()),
      },
    });

    await this.audit.record({
      actor: user,
      ...ctx,
      action: "REPORT_SCHEDULE_CREATE",
      entity: "ReportSchedule",
      entityId: schedule.id,
      after: { type: schedule.type, cadence: describeRecurrence(rule), channels: schedule.channels },
    });

    return this.toView(schedule);
  }

  async update(
    id: string,
    dto: UpdateReportScheduleDto,
    user: AuthenticatedUser,
    ctx: Ctx,
  ): Promise<ReportScheduleView> {
    const existing = await this.mustFind(id, user);
    const merged = { ...existingAsDto(existing), ...stripUndefined(dto) };

    /**
     * The gate is re-applied against the *owner*, not against the caller.
     *
     * An administrator may edit a ward officer's schedule, and the run will
     * still execute as the officer — so allowing the type to be changed to one
     * the officer cannot run would create a schedule guaranteed to fail three
     * times and switch itself off. Refusing here says so at the moment the
     * change is made, to the person making it.
     */
    const owner = existing.ownerId === user.id ? user : await this.principalOf(existing.ownerId);
    if (!owner) {
      throw AppException.forbidden(
        "This schedule's owner no longer has an active account. Delete it, or recreate it under an account that does.",
      );
    }
    this.reports.assertMayRun(merged.type as ReportKey, owner);

    const rule = ruleFrom(merged);
    assertValidRecurrence(rule);

    const schedule = await this.prisma.reportSchedule.update({
      where: { id: existing.id },
      data: {
        name: merged.name,
        type: merged.type,
        params: {
          zoneId: merged.zoneId ?? null,
          vendorId: merged.vendorId ?? null,
          format: merged.format,
        },
        frequency: merged.frequency,
        hour: merged.hour,
        minute: merged.minute,
        weekday: merged.frequency === ReportFrequency.WEEKLY ? (merged.weekday ?? null) : null,
        dayOfMonth: merged.frequency === ReportFrequency.MONTHLY ? (merged.dayOfMonth ?? null) : null,
        timezone: merged.timezone,
        channels: merged.channels,
        isActive: merged.isActive,
        // Recomputed from the edited intent rather than carried over. Editing
        // "08:00" to "06:00" and leaving yesterday's instant in place would run
        // the schedule at the old hour once more before it took effect.
        nextRunAt: nextRunAfter(rule, new Date()),
        // Resuming a schedule that had failed its way to a pause starts the
        // count again. Otherwise a single further failure would switch off
        // something an officer had just deliberately turned back on.
        ...(merged.isActive && !existing.isActive ? { failureCount: 0 } : {}),
      },
    });

    await this.audit.record({
      actor: user,
      ...ctx,
      action: "REPORT_SCHEDULE_UPDATE",
      entity: "ReportSchedule",
      entityId: schedule.id,
      before: { type: existing.type, isActive: existing.isActive, cadence: describeRecurrence(ruleOf(existing)) },
      after: { type: schedule.type, isActive: schedule.isActive, cadence: describeRecurrence(rule) },
    });

    return this.toView(schedule);
  }

  async remove(id: string, user: AuthenticatedUser, ctx: Ctx): Promise<{ deleted: true }> {
    const existing = await this.mustFind(id, user);

    // A schedule genuinely is deletable, unlike a ReportJob. A job records that
    // somebody asked a question of the data on a given day and is the same
    // class of fact as an audit row; a schedule is only an intention to keep
    // asking, and the jobs it produced survive it untouched.
    await this.prisma.reportSchedule.delete({ where: { id: existing.id } });

    await this.audit.record({
      actor: user,
      ...ctx,
      action: "REPORT_SCHEDULE_DELETE",
      entity: "ReportSchedule",
      entityId: existing.id,
      before: { name: existing.name, type: existing.type, ownerId: existing.ownerId },
    });

    return { deleted: true };
  }

  /**
   * Runs a schedule now, without disturbing when it next fires.
   *
   * Deliberately does not touch `nextRunAt`: "run it now" is a request for a
   * copy of the report, not a request to move Monday. It runs as the owner for
   * the reason set out on `scopeOf` — an administrator using this on somebody
   * else's schedule gets the owner's report delivered to the owner, which is
   * the honest meaning of the button.
   */
  async runNow(id: string, user: AuthenticatedUser, ctx: Ctx): Promise<ReportScheduleView> {
    const schedule = await this.mustFind(id, user);

    await this.audit.record({
      actor: user,
      ...ctx,
      action: "REPORT_SCHEDULE_RUN_NOW",
      entity: "ReportSchedule",
      entityId: schedule.id,
      after: { type: schedule.type, ownerId: schedule.ownerId },
    });

    await this.runOne(schedule, new Date(), { advanceSchedule: false });
    return this.toView(await this.prisma.reportSchedule.findUniqueOrThrow({ where: { id: schedule.id } }));
  }

  // -------------------------------------------------------------- the runner

  /**
   * Every schedule that is due, up to the per-invocation cap.
   *
   * Called from the cron endpoint, which authenticates the scheduler with the
   * shared secret; there is no principal here at all, which is why each run
   * builds its owner's principal from the database before touching a report.
   */
  async runDue(now: Date = new Date(), limit: number = SWEEP_LIMIT): Promise<ScheduleSweepSummary> {
    const due = await this.prisma.reportSchedule.findMany({
      where: { isActive: true, nextRunAt: { lte: now } },
      // Oldest-due first, so a backlog drains in the order it accumulated
      // rather than starving whichever schedule sorts last.
      orderBy: { nextRunAt: "asc" },
      take: limit,
    });

    let ran = 0;
    let succeeded = 0;
    let failed = 0;
    let deactivated = 0;

    for (const schedule of due) {
      if (!(await this.claim(schedule, now))) continue;
      ran += 1;

      const outcome = await this.runOne(schedule, now, { advanceSchedule: true });
      if (outcome.ok) succeeded += 1;
      else failed += 1;
      if (outcome.deactivated) deactivated += 1;
    }

    return {
      task: "report-schedules",
      due: due.length,
      ran,
      succeeded,
      failed,
      deactivated,
      sweptAt: now.toISOString(),
    };
  }

  /**
   * Takes ownership of one due schedule, or reports that somebody else has.
   *
   * The `nextRunAt` in the `where` is the whole mechanism: it is the value this
   * sweep read a moment ago, so the update matches only while no other caller
   * has moved it. A second delivery of the same cron tick reads the same row,
   * finds `nextRunAt` already advanced, changes zero rows and skips it. This is
   * the same shape as the overstay sweep's conditional update — the guard is a
   * column the winner changes, not a lock nobody holds.
   *
   * The claim advances the schedule *before* the report runs, which is
   * deliberate. A report that fails does not re-run in the same window; it
   * comes round at its next occurrence, and the failure counter below is what
   * decides when to stop trying at all.
   */
  private async claim(schedule: ReportSchedule, now: Date): Promise<boolean> {
    const { count } = await this.prisma.reportSchedule.updateMany({
      where: { id: schedule.id, isActive: true, nextRunAt: schedule.nextRunAt },
      data: { nextRunAt: nextRunAfter(ruleOf(schedule), now), lastRunAt: now },
    });
    return count === 1;
  }

  /**
   * One run: build the owner's principal, produce the report through the
   * ordinary gate, record the outcome, tell the owner.
   */
  private async runOne(
    schedule: ReportSchedule,
    runAt: Date,
    options: { advanceSchedule: boolean },
  ): Promise<{ ok: boolean; deactivated: boolean }> {
    const owner = await this.principalOf(schedule.ownerId);
    if (!owner) {
      // Not a report that broke — a schedule with nobody left to run it. It is
      // counted as a failure so it switches itself off like any other dead
      // schedule rather than being swept forever.
      return this.recordFailure(
        schedule,
        "The account that owns this schedule is no longer active.",
        options,
      );
    }

    const rule = ruleOf(schedule);
    const period = periodFor(rule, runAt);
    const params = paramsOf(schedule);

    try {
      /**
       * The same call the button makes.
       *
       * `generate` asserts the gate, writes the ReportJob under the owner's id,
       * builds the table and marks the job COMPLETED or FAILED — so a scheduled
       * run appears in the history screen beside the interactive ones, with the
       * owner named as the requester, and nothing here has to reimplement any
       * of it. The one outcome it deliberately does *not* record as a job is a
       * refusal, because a refusal is not a report that broke; that shows up
       * here as a failure on the schedule instead, which is where it belongs.
       */
      const job = await this.reports.generate(
        {
          type: schedule.type as ReportKey,
          from: period.from,
          to: period.to,
          zoneId: params.zoneId ?? undefined,
          vendorId: params.vendorId ?? undefined,
          format: "csv",
        },
        owner,
        { requestId: `schedule:${schedule.id}` },
      );

      await this.prisma.reportSchedule.update({
        where: { id: schedule.id },
        data: {
          lastStatus: ReportStatus.COMPLETED,
          lastError: null,
          lastJobId: job.id,
          // A success clears the count: the cap counts *consecutive* failures,
          // so an intermittent outage never accumulates towards a pause.
          failureCount: 0,
          ...(options.advanceSchedule ? {} : { lastRunAt: runAt }),
        },
      });

      await this.announce(schedule, owner, job.rowCount, period);
      return { ok: true, deactivated: false };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      this.logger.error(`Scheduled report "${schedule.name}" (${schedule.id}) failed: ${message}`);
      return this.recordFailure(schedule, message, options);
    }
  }

  /**
   * Records a failure and, at the cap, switches the schedule off and says so.
   *
   * Deactivating is the point. The failures a schedule actually suffers are
   * almost all permanent — the owner's role was narrowed, the zone was deleted,
   * the report moved to an authority-wide audience — and a platform that
   * retried those every morning would produce a FAILED job a day, forever,
   * against an officer who has long stopped looking. Stopping is louder than
   * retrying, provided somebody is told, which is what the alert is for.
   */
  private async recordFailure(
    schedule: ReportSchedule,
    message: string,
    options: { advanceSchedule: boolean },
  ): Promise<{ ok: boolean; deactivated: boolean }> {
    const failures = schedule.failureCount + 1;
    const exhausted = failures >= MAX_CONSECUTIVE_FAILURES;

    await this.prisma.reportSchedule.update({
      where: { id: schedule.id },
      data: {
        failureCount: failures,
        lastStatus: ReportStatus.FAILED,
        lastError: message,
        ...(exhausted ? { isActive: false } : {}),
        ...(options.advanceSchedule ? {} : { lastRunAt: new Date() }),
      },
    });

    if (exhausted) {
      /**
       * Raised in the portal's own bell rather than sent over the schedule's
       * delivery channels, and that is a deliberate limit rather than an
       * oversight. The message catalogue has one report template — `report.ready`
       * — and "your schedule has been switched off" is not a report being
       * ready; announcing it under that heading would be a message that
       * contradicts itself. The owner is by definition somebody who signs in to
       * the portal, so the bell reaches them, and the schedule row itself
       * carries the reason for anyone who goes looking.
       */
      await this.notifications.raise({
        userId: schedule.ownerId,
        template: "report.schedule.paused",
        payload: {
          title: `"${schedule.name}" has been paused`,
          body:
            `The schedule failed ${failures} times in a row and has been switched off rather than ` +
            `retried. Last error: ${message}`,
          href: "/reports",
        },
      });
      this.logger.warn(
        `Deactivated report schedule ${schedule.id} after ${failures} consecutive failures.`,
      );
    }

    return { ok: false, deactivated: exhausted };
  }

  /**
   * Tells the owner their report has been produced.
   *
   * `report.ready` is reused exactly as `MessagingService.emailReport` uses it,
   * and no second template is written: an officer must not be able to tell
   * whether the report they were sent came from the button or the schedule,
   * because as far as the report is concerned there is no difference.
   *
   * No download URL goes into the payload. Nothing is stored — a report is
   * regenerated on download so the file can never disagree with the data — so a
   * link would have to be to the portal, behind a sign-in, and the template
   * renders its "the download link expires shortly" footer only when a URL is
   * present. The bell alert beside it is what actually gets the officer to the
   * history screen.
   */
  private async announce(
    schedule: ReportSchedule,
    owner: AuthenticatedUser,
    rowCount: number,
    period: { from: Date; to: Date },
  ): Promise<void> {
    const rangeLabel = periodLabel(period, schedule.timezone);
    const payload = {
      reportName: schedule.name,
      format: "csv",
      generatedAt: new Date(),
      rangeLabel,
      rowCount,
    };

    const channels = schedule.channels.filter(isDeliverableChannel) as DeliverableChannel[];
    if (channels.length > 0) {
      // Never throws — see MessagingService.dispatch. A provider having a bad
      // afternoon must not turn a report that was produced into a run recorded
      // as failed.
      await this.messaging.dispatch({
        recipientUserId: owner.id,
        template: "report.ready",
        payload,
        channels,
      });
    }

    await this.notifications.raise({
      userId: owner.id,
      template: "report.ready",
      payload: {
        title: `${schedule.name} is ready`,
        body: `${reportLabel(schedule.type)} · ${rangeLabel} · ${rowCount} rows`,
        href: "/reports",
      },
    });
  }

  /**
   * Rebuilds the schedule owner as an authenticated principal.
   *
   * This is the load-bearing piece of the whole subsystem. The cron caller has
   * no account, so without this a scheduled run would have to be executed by
   * something unscoped — and every zone rule in `ReportsService` is expressed
   * in terms of a principal. What is assembled here is exactly what
   * `JwtAuthGuard` assembles from a token: the role, the zone-scoped flag read
   * from the role rather than guessed from an empty array, the vendor id, and
   * the zone allocation from the same three places the guard reads it.
   *
   * An account that has been suspended, blacklisted or soft-deleted yields
   * nothing, and the run is recorded as a failure. Continuing to produce
   * reports for somebody whose access was revoked is precisely what revoking
   * access was meant to stop.
   */
  private async principalOf(ownerId: string): Promise<AuthenticatedUser | null> {
    const user = await this.prisma.user.findFirst({
      where: { id: ownerId, status: UserStatus.ACTIVE, deletedAt: null },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        role: true,
        vendor: { select: { id: true, zones: { select: { zoneId: true, endedAt: true } } } },
        attendant: { select: { id: true, vendorId: true } },
      },
    });
    if (!user) return null;

    return {
      id: user.id,
      role: user.role,
      isZoneScoped: await this.roles.isZoneScoped(user.role),
      name: user.name,
      email: user.email,
      phone: user.phone,
      vendorId: user.vendor?.id ?? user.attendant?.vendorId ?? null,
      attendantId: user.attendant?.id ?? null,
      zoneIds: await this.zoneScopeOfUser(user),
      // There is no session: this principal was assembled from a row, not
      // presented with a token. The marker says so rather than borrowing an id
      // that would look like somebody's live sign-in in the audit trail.
      sessionId: `schedule:${user.id}`,
    };
  }

  /** The same three sources `JwtAuthGuard.resolveZoneScope` reads, in the same order. */
  private async zoneScopeOfUser(user: {
    id: string;
    vendor: { zones: { zoneId: string; endedAt: Date | null }[] } | null;
    attendant: { vendorId: string } | null;
  }): Promise<string[]> {
    if (user.vendor) return user.vendor.zones.filter((z) => !z.endedAt).map((z) => z.zoneId);

    if (user.attendant) {
      const assignments = await this.prisma.vendorZone.findMany({
        where: { vendorId: user.attendant.vendorId, endedAt: null },
        select: { zoneId: true },
      });
      return assignments.map((a) => a.zoneId);
    }

    const scope = await this.prisma.systemConfig.findUnique({
      where: { key: `zoneScope:${user.id}` },
    });
    return Array.isArray(scope?.value) ? (scope.value as string[]) : [];
  }

  // --------------------------------------------------------------- the view

  private async toView(row: ReportSchedule): Promise<ReportScheduleView> {
    return (await this.toViews([row]))[0];
  }

  /**
   * Resolves the names a row only holds ids for, in one query per kind rather
   * than one per row — the same shape `ReportsService.list` uses for requesters.
   */
  private async toViews(rows: ReportSchedule[]): Promise<ReportScheduleView[]> {
    if (rows.length === 0) return [];

    const paramsByRow = new Map(rows.map((row) => [row.id, paramsOf(row)]));
    const ownerIds = [...new Set(rows.map((r) => r.ownerId))];
    const zoneIds = [...new Set([...paramsByRow.values()].map((p) => p.zoneId).filter(isId))];
    const vendorIds = [...new Set([...paramsByRow.values()].map((p) => p.vendorId).filter(isId))];

    const [owners, zones, vendors] = await Promise.all([
      this.prisma.user.findMany({ where: { id: { in: ownerIds } }, select: { id: true, name: true } }),
      zoneIds.length
        ? this.prisma.zone.findMany({ where: { id: { in: zoneIds } }, select: { id: true, name: true } })
        : Promise.resolve([]),
      vendorIds.length
        ? this.prisma.vendor.findMany({
            where: { id: { in: vendorIds } },
            select: { id: true, orgName: true },
          })
        : Promise.resolve([]),
    ]);

    const ownerName = new Map(owners.map((o) => [o.id, o.name]));
    const zoneName = new Map(zones.map((z) => [z.id, z.name]));
    const vendorName = new Map(vendors.map((v) => [v.id, v.orgName]));

    return rows.map((row) => {
      const params = paramsByRow.get(row.id)!;
      const rule = ruleOf(row);
      const scopeLabel = params.zoneId
        ? (zoneName.get(params.zoneId) ?? "One zone")
        : params.vendorId
          ? (vendorName.get(params.vendorId) ?? "One vendor")
          : "All zones";

      return {
        id: row.id,
        name: row.name,
        type: row.type,
        label: reportLabel(row.type),
        frequency: row.frequency,
        hour: row.hour,
        minute: row.minute,
        weekday: row.weekday,
        dayOfMonth: row.dayOfMonth,
        timezone: row.timezone,
        cadence: describeRecurrence(rule),
        zoneId: params.zoneId,
        vendorId: params.vendorId,
        paramsLabel: `${windowLabel(row.frequency)} · ${scopeLabel}`,
        channels: row.channels,
        ownerId: row.ownerId,
        ownerName: ownerName.get(row.ownerId) ?? "—",
        isActive: row.isActive,
        nextRunAt: row.nextRunAt,
        lastRunAt: row.lastRunAt,
        lastStatus: row.lastStatus,
        lastError: row.lastError,
        lastJobId: row.lastJobId,
        failureCount: row.failureCount,
        failuresBeforePause: MAX_CONSECUTIVE_FAILURES,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      };
    });
  }
}

// ------------------------------------------------------------------ helpers

function isId(value: string | null): value is string {
  return typeof value === "string" && value.length > 0;
}

/** The recurrence intent carried by a stored row. */
function ruleOf(schedule: ReportSchedule): RecurrenceRule {
  return {
    frequency: schedule.frequency,
    hour: schedule.hour,
    minute: schedule.minute,
    weekday: schedule.weekday,
    dayOfMonth: schedule.dayOfMonth,
    timezone: schedule.timezone,
  };
}

/** The same, from a create or merged-update payload. */
function ruleFrom(dto: {
  frequency: ReportFrequency;
  hour: number;
  minute: number;
  weekday?: number | null;
  dayOfMonth?: number | null;
  timezone: string;
}): RecurrenceRule {
  return {
    frequency: dto.frequency,
    hour: dto.hour,
    minute: dto.minute,
    weekday: dto.weekday ?? null,
    dayOfMonth: dto.dayOfMonth ?? null,
    timezone: dto.timezone,
  };
}

/** The Json column, read back with the shape it was written with. */
function paramsOf(schedule: ReportSchedule): {
  zoneId: string | null;
  vendorId: string | null;
  format: string;
} {
  const params = (schedule.params ?? {}) as Record<string, unknown>;
  return {
    zoneId: typeof params.zoneId === "string" ? params.zoneId : null,
    vendorId: typeof params.vendorId === "string" ? params.vendorId : null,
    format: typeof params.format === "string" ? params.format : "csv",
  };
}

/** The stored row as the fields an update merges over. */
function existingAsDto(schedule: ReportSchedule) {
  const params = paramsOf(schedule);
  return {
    name: schedule.name,
    type: schedule.type,
    frequency: schedule.frequency,
    hour: schedule.hour,
    minute: schedule.minute,
    weekday: schedule.weekday,
    dayOfMonth: schedule.dayOfMonth,
    timezone: schedule.timezone,
    zoneId: params.zoneId,
    vendorId: params.vendorId,
    format: "csv" as const,
    channels: schedule.channels as NotificationChannel[],
    isActive: schedule.isActive,
  };
}

/**
 * Drops keys the caller did not send.
 *
 * A PATCH body parsed by an optional-everything schema still carries every key
 * as `undefined`, and spreading that over the stored row would blank the lot.
 * `null` is kept, because for `zoneId` and `vendorId` it is a real value
 * meaning "no longer narrowed to one".
 */
function stripUndefined<T extends object>(dto: T): Partial<T> {
  return Object.fromEntries(Object.entries(dto).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** "The previous 7 days" — what a cadence means for the period it reports on. */
function windowLabel(frequency: ReportFrequency): string {
  switch (frequency) {
    case ReportFrequency.DAILY:
      return "Yesterday";
    case ReportFrequency.WEEKLY:
      return "The previous 7 days";
    case ReportFrequency.MONTHLY:
      return "The previous calendar month";
  }
}

/**
 * "01 Sep – 30 Sep 2026", read in the schedule's own zone.
 *
 * The window's boundaries are stored as instants — the end of one is a
 * millisecond before a local midnight — so rendering them in UTC would print
 * the end of a local month as the last day minus one. That is exactly the
 * off-by-a-day that makes a finance office distrust a report, and it is the
 * whole reason the zone travelled this far down the call.
 */
function periodLabel(period: { from: Date; to: Date }, zone: string): string {
  const from = zonedParts(period.from, zone);
  const to = zonedParts(period.to, zone);
  const month = (m: number) =>
    ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][m - 1];
  const day = (p: { day: number; month: number }) =>
    `${String(p.day).padStart(2, "0")} ${month(p.month)}`;
  return `${day(from)} – ${day(to)} ${to.year}`;
}
