import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";

import { SessionsService } from "./sessions.service";

/**
 * Promotes long-running sessions to OVERSTAY on a schedule.
 *
 * Overstay is derivable from elapsed time on every read, so nothing is *wrong*
 * between sweeps — this exists so the status can be filtered and reported on,
 * which an enforcement list needs.
 *
 * Note this only runs where a process stays alive. On the serverless deployment
 * the container is torn down between requests, so this must eventually be
 * driven by a scheduled call to the endpoint instead. Until then, the derived
 * `isOverstay` on each session is the reliable answer and the stored status is
 * a convenience.
 */
@Injectable()
export class OverstayTask {
  private readonly logger = new Logger(OverstayTask.name);

  constructor(private readonly sessions: SessionsService) {}

  @Cron(CronExpression.EVERY_10_MINUTES)
  async sweep(): Promise<void> {
    try {
      await this.sessions.markOverstays();
    } catch (error) {
      // A failed sweep must not take the process down; the next one will catch up.
      this.logger.error(`Overstay sweep failed: ${String(error)}`);
    }
  }
}
