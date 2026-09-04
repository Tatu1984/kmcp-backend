import { Global, Module } from "@nestjs/common";
import { PrivacyModule } from "@/modules/privacy/privacy.module";
import { ActivityController } from "./activity.controller";
import { ActivityService } from "./activity.service";
import { AuthEventService } from "./auth-event.service";

/**
 * Global so the auth module can record sign-in events without a circular
 * import back into activity.
 */
@Global()
@Module({
  // For ConsentService: every answer to the location prompt is also appended to
  // the consent ledger, which is what makes it demonstrable.
  imports: [PrivacyModule],
  controllers: [ActivityController],
  providers: [ActivityService, AuthEventService],
  exports: [AuthEventService, ActivityService],
})
export class ActivityModule {}
