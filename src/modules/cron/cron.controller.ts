import { Controller, Get, Logger, Post, Req } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Throttle } from "@nestjs/throttler";
import { ApiExcludeEndpoint, ApiOperation, ApiTags } from "@nestjs/swagger";
import { createHash, timingSafeEqual } from "node:crypto";
import type { Request } from "express";

import { Public } from "@/common/decorators/auth.decorators";
import { AppException } from "@/common/errors/app.exception";
import { HEADERS } from "@/config/app.constants";
import type { Env } from "@/config/env.config";
import { SessionsService } from "@/modules/sessions/sessions.service";
import { RetentionService } from "@/modules/privacy/retention.service";
import { ReportSchedulesService } from "@/modules/reports/report-schedules.service";

/**
 * The same refusal whichever way the caller failed.
 *
 * A distinct "the secret is not configured" would tell anyone who probes this
 * URL that the deployment is misconfigured and worth coming back to. The real
 * reason goes to the logs, where the operator will look.
 */
const REFUSAL = "This endpoint is for the scheduler.";

/**
 * Scheduled work, triggered from outside.
 *
 * `OverstayTask` runs the same sweep on an in-process timer, which works
 * wherever a process stays alive and never fires on the serverless deployment:
 * the container is torn down between requests, so there is no process left
 * holding the timer. Vercel Cron calls this instead.
 *
 * Authentication is a shared secret rather than a token, because the caller is
 * a scheduler with no account, no role and no session to bind to. Vercel sends
 * it as `Authorization: Bearer $CRON_SECRET`; `x-cron-secret` is accepted too,
 * for a self-hosted scheduler or a curl from an operator.
 */
@ApiTags("System")
@Controller("cron")
export class CronController {
  private readonly logger = new Logger(CronController.name);

  constructor(
    private readonly sessions: SessionsService,
    private readonly config: ConfigService<Env, true>,
    private readonly retention: RetentionService,
    private readonly reportSchedules: ReportSchedulesService,
  ) {}

  /**
   * Vercel Cron issues a GET and nothing else — there is no way to ask it for a
   * POST. This is the route that actually runs in production.
   */
  @Public()
  @Throttle({ strict: { ttl: 60_000, limit: 6 } })
  @Get("overstay-sweep")
  @ApiExcludeEndpoint()
  sweepViaGet(@Req() request: Request) {
    return this.overstaySweep(request);
  }

  /**
   * The same sweep as a POST, which is the honest verb for something that
   * writes. Kept for operators, for any scheduler that can be told to use it,
   * and because a GET that mutates is a trap for a prefetcher.
   */
  @Public()
  @Throttle({ strict: { ttl: 60_000, limit: 6 } })
  @Post("overstay-sweep")
  @ApiOperation({
    summary: "Promote long-running sessions to OVERSTAY",
    description:
      "Authenticated by the CRON_SECRET shared secret, not by a bearer token — the caller is a " +
      "scheduler with no account. Safe to call twice: the second call finds nothing left to change.",
  })
  async overstaySweep(@Req() request: Request) {
    this.assertScheduler(request);

    // Idempotent by construction: the update matches only sessions still ACTIVE
    // past the cutoff, so a duplicate delivery — two schedulers, a retry, an
    // operator running it by hand — changes zero rows the second time.
    const swept = await this.sessions.markOverstays();

    return { task: "overstay-sweep", swept, sweptAt: new Date().toISOString() };
  }

  /**
   * Vercel Cron issues a GET, so this is the route that runs in production.
   */
  @Public()
  @Throttle({ strict: { ttl: 60_000, limit: 6 } })
  @Get("retention-purge")
  @ApiExcludeEndpoint()
  purgeViaGet(@Req() request: Request) {
    return this.retentionPurge(request);
  }

  /**
   * Enforces the retention schedule the authority has configured.
   *
   * The one endpoint on this platform whose ordinary outcome is that data
   * ceases to exist, which is why almost everything about it is a brake. It
   * runs at most once a day rather than every ten minutes: the periods are
   * measured in days, so a more frequent sweep would buy nothing and would only
   * multiply the number of chances to destroy the wrong thing.
   *
   * `retention.dryRun` is seeded true, so a fresh deployment reports and
   * deletes nothing until the authority has confirmed the periods. It is
   * bounded per class, so a large backlog is eaten over several days rather
   * than attempted inside one thirty-second function. And it is idempotent — a
   * duplicate delivery finds nothing left past the cutoff and says so.
   */
  @Public()
  @Throttle({ strict: { ttl: 60_000, limit: 6 } })
  @Post("retention-purge")
  @ApiOperation({
    summary: "Destroy records that have outlived their retention period",
    description:
      "Authenticated by CRON_SECRET like the sweep above. Report-only until retention.dryRun is " +
      "turned off. Anything under legal hold, on an unconcluded or disputed session, or attached " +
      "to an open incident is left alone. Every run writes an audit row with counts and no content.",
  })
  async retentionPurge(@Req() request: Request) {
    this.assertScheduler(request);

    const outcome = await this.retention.purge({ requestId: request.header(HEADERS.requestId) });

    if (outcome.legalHold) {
      this.logger.warn("A blanket legal hold is in force — the purge counted and destroyed nothing.");
    }

    return { task: "retention-purge", ...outcome };
  }

  /**
   * Vercel Cron issues a GET, so this is the route that runs in production.
   */
  @Public()
  @Throttle({ strict: { ttl: 60_000, limit: 6 } })
  @Get("report-schedules")
  @ApiExcludeEndpoint()
  reportSchedulesViaGet(@Req() request: Request) {
    return this.runReportSchedules(request);
  }

  /**
   * Runs every report schedule that has fallen due.
   *
   * This is the only thing that makes a recurring report recur. The `@Cron`
   * decorator will not do it — the container is torn down between requests on
   * the serverless deployment, so nothing is left holding a timer — and the
   * report engine runs inline rather than on a queue, so there is no worker to
   * drain either. An external tick is the whole mechanism.
   *
   * Every run executes as the schedule's owner and passes through the same
   * authorisation gate as the button in the portal, which matters here more
   * than anywhere: this endpoint authenticates a scheduler, not a person, and a
   * schedule must not become a way for an officer to receive a report they are
   * refused when they press the button. See `ReportSchedulesService`.
   *
   * Bounded and idempotent, like the sweep above. Each due schedule is claimed
   * by a conditional update on the `nextRunAt` this invocation read, so a
   * duplicate delivery claims nothing and runs nothing; and only a handful are
   * taken per invocation, so a backlog drains across ticks rather than timing
   * one function out.
   */
  @Public()
  @Throttle({ strict: { ttl: 60_000, limit: 6 } })
  @Post("report-schedules")
  @ApiOperation({
    summary: "Run report schedules that have fallen due",
    description:
      "Authenticated by CRON_SECRET like the sweeps above. Each report runs as the schedule's " +
      "owner, through the same permission gate as an interactive run. Safe to call twice: the " +
      "second call finds every due schedule already claimed.",
  })
  async runReportSchedules(@Req() request: Request) {
    this.assertScheduler(request);

    const outcome = await this.reportSchedules.runDue();

    if (outcome.deactivated > 0) {
      this.logger.warn(
        `${outcome.deactivated} report schedule(s) were switched off after repeated failures. ` +
          "Their owners have been told in the portal.",
      );
    }

    return outcome;
  }

  /**
   * Refuses unless the caller presents the configured secret.
   *
   * An unset `CRON_SECRET` refuses everything. The alternative — treating "no
   * secret configured" as "no authentication required" — would leave a
   * world-writable endpoint on any deployment where the variable was forgotten,
   * which is precisely the deployment least likely to notice.
   */
  private assertScheduler(request: Request): void {
    const configured = this.config.get("CRON_SECRET", { infer: true });
    if (!configured) {
      this.logger.error(
        "CRON_SECRET is not set. Refusing the sweep rather than running it for anyone who asks — " +
          "set the variable and redeploy.",
      );
      throw AppException.forbidden(REFUSAL);
    }

    const presented = this.presentedSecret(request);
    if (!presented || !secretsMatch(presented, configured)) {
      this.logger.warn(`Refused an overstay sweep from ${request.ip ?? "an unknown address"}`);
      throw AppException.forbidden(REFUSAL);
    }
  }

  private presentedSecret(request: Request): string | undefined {
    const header = request.header("authorization");
    if (header?.startsWith("Bearer ")) return header.slice(7).trim() || undefined;
    return request.header(HEADERS.cronSecret)?.trim() || undefined;
  }
}

/**
 * Compares two secrets without leaking how far the comparison got.
 *
 * Both sides are hashed first so `timingSafeEqual` is handed two 32-byte
 * buffers. It throws on a length mismatch, and that throw would itself be a
 * side channel telling an attacker the length of the real secret — the very
 * thing a constant-time compare is here to avoid.
 */
function secretsMatch(presented: string, configured: string): boolean {
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(configured).digest();
  return timingSafeEqual(a, b);
}
