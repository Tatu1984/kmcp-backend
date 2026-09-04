import { Module } from "@nestjs/common";
import { NotificationsController } from "./notifications.controller";
import { NotificationsService } from "./notifications.service";

/**
 * Exported so any module can raise an alert without importing the controller.
 * The emitters belong with the events that cause them — a settlement is best
 * placed to say a settlement needs approval — not in a central switchboard
 * that would have to know about every workflow in the platform.
 */
@Module({
  controllers: [NotificationsController],
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
