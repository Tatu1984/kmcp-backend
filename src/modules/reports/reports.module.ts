import { Module } from "@nestjs/common";

import { MessagingModule } from "@/modules/messaging/messaging.module";
import { NotificationsModule } from "@/modules/notifications/notifications.module";
import { ReportsController } from "./reports.controller";
import { ReportsService } from "./reports.service";
import { ReportSchedulesController } from "./report-schedules.controller";
import { ReportSchedulesService } from "./report-schedules.service";

/**
 * The schedules controller is listed first so `/reports/schedules` is matched
 * before anything `ReportsController` might one day mount at `/reports/:id`.
 *
 * Messaging and notifications are imported because a report that nobody is told
 * about is not a delivered report — the interactive path hands the file straight
 * back to the browser, and a scheduled one has no browser to hand it to.
 */
@Module({
  imports: [MessagingModule, NotificationsModule],
  controllers: [ReportSchedulesController, ReportsController],
  providers: [ReportsService, ReportSchedulesService],
  exports: [ReportsService, ReportSchedulesService],
})
export class ReportsModule {}
