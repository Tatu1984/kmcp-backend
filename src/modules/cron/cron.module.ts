import { Module } from "@nestjs/common";

import { SessionsModule } from "@/modules/sessions/sessions.module";
import { PrivacyModule } from "@/modules/privacy/privacy.module";
import { ReportsModule } from "@/modules/reports/reports.module";
import { CronController } from "./cron.controller";

/**
 * The externally triggered half of the scheduled work. The in-process half
 * lives beside the service it sweeps, in SessionsModule.
 */
@Module({
  imports: [SessionsModule, PrivacyModule, ReportsModule],
  controllers: [CronController],
})
export class CronModule {}
