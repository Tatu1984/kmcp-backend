import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Cron, CronExpression } from "@nestjs/schedule";

import type { Env } from "@/config/env.config";
import { SessionsService } from "./sessions.service";

/**
 * Promotes long-running sessions to OVERSTAY on a schedule.
 *
 * Overstay is derivable from elapsed time on every read, so nothing is *wrong*
 * between sweeps — this exists so the status can be filtered and reported on,
 * which an enforcement list needs.
 *
 * This timer only fires where a process stays alive. On the serverless
 * deployment the container is torn down between requests, so it has never once
 * run in production; `POST /cron/overstay-sweep` is what runs it there, called
 * by Vercel Cron.
 *
 * Both can be registered at the same time without harm — the sweep is an
 * `updateMany` over sessions still ACTIVE past the cutoff, so whichever runs
 * second finds nothing to do. The timer is nevertheless skipped on a serverless
 * platform rather than left running: a scheduled task that cannot fire, quietly
 * doing nothing, is exactly the misreading that hid this problem in the first
 * place, and a log line saying so is worth more than a silent no-op.
 */
@Injectable()
export class OverstayTask {
  private readonly logger = new Logger(OverstayTask.name);

  constructor(
    private readonly sessions: SessionsService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /** Vercel sets VERCEL on every deployment; nothing else does. */
  private get serverless(): boolean {
    return Boolean(this.config.get("VERCEL", { infer: true }));
  }

  @Cron(CronExpression.EVERY_10_MINUTES)
  async sweep(): Promise<void> {
    if (this.serverless) {
      // Reached only if the container happens to survive ten minutes, which is
      // rare and not something to depend on. The scheduled call is the one that
      // counts, and letting this run too would just race it to no effect.
      this.logger.debug("Skipping the in-process sweep; the scheduler drives it on this platform.");
      return;
    }

    try {
      await this.sessions.markOverstays();
    } catch (error) {
      // A failed sweep must not take the process down; the next one will catch up.
      this.logger.error(`Overstay sweep failed: ${String(error)}`);
    }
  }
}
