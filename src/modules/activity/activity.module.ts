import { Global, Module } from "@nestjs/common";
import { ActivityController } from "./activity.controller";
import { ActivityService } from "./activity.service";
import { AuthEventService } from "./auth-event.service";

/**
 * Global so the auth module can record sign-in events without a circular
 * import back into activity.
 */
@Global()
@Module({
  controllers: [ActivityController],
  providers: [ActivityService, AuthEventService],
  exports: [AuthEventService, ActivityService],
})
export class ActivityModule {}
