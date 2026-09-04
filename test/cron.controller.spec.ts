import { describe, expect, it, vi } from "vitest";

import { CronController } from "../src/modules/cron/cron.controller";
import { AppException } from "../src/common/errors/app.exception";

/**
 * The scheduled sweep's front door.
 *
 * This endpoint has no bearer token behind it — the caller is Vercel Cron,
 * which has no account and no session. A shared secret is the whole of its
 * authentication, so the cases that matter are the ways that secret can be got
 * wrong: absent, mistyped, a different length, or never configured at all.
 *
 * The last one is the dangerous default. An unset CRON_SECRET must refuse
 * everything rather than read as "no authentication required" — a deployment
 * where the variable was forgotten is the one least likely to notice that
 * anyone on the internet can drive its writes.
 */

const SECRET = "s3cret-value-for-the-scheduler";

/** The variable is absent from the environment. Spelled out, because passing
 *  `undefined` to a defaulted parameter would silently mean "use the default". */
const UNSET = null;

function makeController(configured: string | null = SECRET, swept = 3) {
  const sessions = { markOverstays: vi.fn().mockResolvedValue(swept) };
  const config = {
    get: vi
      .fn()
      .mockImplementation((key: string) => (key === "CRON_SECRET" ? (configured ?? undefined) : undefined)),
  };
  // The retention sweep shares this controller and this secret. It is stubbed
  // here rather than exercised — its own boundaries are tested against the
  // service in retention.service.spec.ts; what matters on this side is that the
  // second scheduled route is behind the same refusal as the first.
  const retention = { purge: vi.fn().mockResolvedValue({ totalPurged: 0, classes: [] }) };
  // And so does the report-schedule runner, for the same reason. Its own
  // boundaries — due selection, the double-invocation claim, the failure cap —
  // are tested against the service in report-schedules.spec.ts; here it is a
  // stub, because what this file is about is the shared refusal in front of it.
  const reportSchedules = {
    runDue: vi.fn().mockResolvedValue({
      task: "report-schedules",
      due: 0,
      ran: 0,
      succeeded: 0,
      failed: 0,
      deactivated: 0,
      sweptAt: new Date().toISOString(),
    }),
  };
  return {
    controller: new CronController(
      sessions as any,
      config as any,
      retention as any,
      reportSchedules as any,
    ),
    sessions,
    retention,
    reportSchedules,
  };
}

/** Only the two things the controller reads off the request. */
const request = (headers: Record<string, string>) =>
  ({
    ip: "203.0.113.9",
    header: (name: string) => headers[name.toLowerCase()],
  }) as any;

const bearer = (secret: string) => request({ authorization: `Bearer ${secret}` });

async function expectRefusal(promise: Promise<unknown>) {
  await expect(promise).rejects.toBeInstanceOf(AppException);
  await promise.catch((error: AppException) => expect(error.code).toBe("FORBIDDEN"));
}

describe("authenticating the scheduler", () => {
  it("runs the sweep for the configured secret", async () => {
    const { controller, sessions } = makeController();

    const result = await controller.overstaySweep(bearer(SECRET));

    expect(sessions.markOverstays).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ task: "overstay-sweep", swept: 3 });
  });

  it("accepts the secret in x-cron-secret too", async () => {
    const { controller, sessions } = makeController();

    // For a self-hosted scheduler, or an operator with curl.
    await controller.overstaySweep(request({ "x-cron-secret": SECRET }));
    expect(sessions.markOverstays).toHaveBeenCalled();
  });

  it("refuses a wrong secret and does not sweep", async () => {
    const { controller, sessions } = makeController();

    await expectRefusal(controller.overstaySweep(bearer("not-the-secret-at-all-no")));
    expect(sessions.markOverstays).not.toHaveBeenCalled();
  });

  it("refuses a secret of a different length rather than failing on it", async () => {
    const { controller } = makeController();

    // timingSafeEqual throws outright on unequal buffers, and that throw would
    // itself tell an attacker the real secret's length. Both sides are hashed
    // first, so this is an ordinary refusal.
    await expectRefusal(controller.overstaySweep(bearer("short")));
    await expectRefusal(controller.overstaySweep(bearer(`${SECRET}-and-then-some-more`)));
  });

  it("refuses a call with no secret at all", async () => {
    const { controller } = makeController();
    await expectRefusal(controller.overstaySweep(request({})));
  });

  it("refuses everything when CRON_SECRET is unset", async () => {
    const { controller, sessions } = makeController(UNSET);

    // Including a caller that presents something plausible. An unconfigured
    // deployment is closed, not open.
    await expectRefusal(controller.overstaySweep(request({})));
    await expectRefusal(controller.overstaySweep(bearer(SECRET)));
    expect(sessions.markOverstays).not.toHaveBeenCalled();
  });

  it("refuses an empty CRON_SECRET the same way", async () => {
    const { controller } = makeController("");
    await expectRefusal(controller.overstaySweep(bearer("")));
  });

  it("says the same thing whether the secret is wrong or unset", async () => {
    const wrong = await makeController()
      .controller.overstaySweep(bearer("wrong"))
      .catch((error: AppException) => error);
    const unset = await makeController(UNSET)
      .controller.overstaySweep(bearer(SECRET))
      .catch((error: AppException) => error);

    // A distinct message would tell anyone probing the URL that this deployment
    // is misconfigured and worth coming back to.
    expect((wrong as AppException).getResponse()).toEqual((unset as AppException).getResponse());
  });
});

describe("running it twice", () => {
  it("is safe to invoke again — the second call finds nothing left", async () => {
    const { controller, sessions } = makeController();
    sessions.markOverstays.mockResolvedValueOnce(3).mockResolvedValueOnce(0);

    const first = await controller.overstaySweep(bearer(SECRET));
    const second = await controller.overstaySweep(bearer(SECRET));

    // The sweep matches only sessions still ACTIVE past the cutoff, so a
    // duplicate delivery changes nothing and reports honestly that it did.
    expect(first.swept).toBe(3);
    expect(second.swept).toBe(0);
  });
});

describe("the retention purge behind the same secret", () => {
  it("refuses a wrong secret and purges nothing", async () => {
    const { controller, retention } = makeController();

    await expectRefusal(controller.retentionPurge(bearer("not-the-secret-at-all-no")));
    await expectRefusal(controller.purgeViaGet(request({})));
    // The one endpoint whose ordinary outcome is that data ceases to exist.
    // An unauthenticated caller must not reach it by any verb.
    expect(retention.purge).not.toHaveBeenCalled();
  });

  it("refuses everything when CRON_SECRET is unset", async () => {
    const { controller, retention } = makeController(UNSET);
    await expectRefusal(controller.retentionPurge(bearer(SECRET)));
    expect(retention.purge).not.toHaveBeenCalled();
  });

  it("runs the sweep for the configured secret", async () => {
    const { controller, retention } = makeController();

    const result = await controller.retentionPurge(bearer(SECRET));

    expect(retention.purge).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ task: "retention-purge", totalPurged: 0 });
  });
});

describe("the GET route Vercel Cron actually calls", () => {
  it("is the same sweep, with the same secret check", async () => {
    const { controller, sessions } = makeController();

    await expectRefusal(controller.sweepViaGet(bearer("wrong")));
    await expect(controller.sweepViaGet(bearer(SECRET))).resolves.toMatchObject({ swept: 3 });
    expect(sessions.markOverstays).toHaveBeenCalledTimes(1);
  });
});

describe("the report-schedule runner behind the same door", () => {
  it("refuses without the secret, and does not run a single schedule", async () => {
    const { controller, reportSchedules } = makeController();

    // The important half. This endpoint drives report generation for other
    // people's accounts — every run executes as the schedule's owner — so an
    // unauthenticated caller reaching it would be able to make the platform
    // produce and deliver reports on demand, for anyone.
    await expectRefusal(controller.runReportSchedules(request({})));
    await expectRefusal(controller.runReportSchedules(bearer("not-the-secret-at-all-no")));
    expect(reportSchedules.runDue).not.toHaveBeenCalled();
  });

  it("refuses everything when CRON_SECRET is unset", async () => {
    const { controller, reportSchedules } = makeController(UNSET);

    await expectRefusal(controller.runReportSchedules(bearer(SECRET)));
    expect(reportSchedules.runDue).not.toHaveBeenCalled();
  });

  it("runs the due schedules for the configured secret", async () => {
    const { controller, reportSchedules } = makeController();

    const result = await controller.runReportSchedules(bearer(SECRET));

    expect(reportSchedules.runDue).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ task: "report-schedules", due: 0, ran: 0 });
  });

  it("is the same run on the GET route Vercel Cron actually calls", async () => {
    const { controller, reportSchedules } = makeController();

    await expectRefusal(controller.reportSchedulesViaGet(bearer("wrong")));
    await expect(controller.reportSchedulesViaGet(bearer(SECRET))).resolves.toMatchObject({
      task: "report-schedules",
    });
    expect(reportSchedules.runDue).toHaveBeenCalledTimes(1);
  });
});
