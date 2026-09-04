import { Module } from "@nestjs/common";

import { MessagingController } from "./messaging.controller";
import { MessagingService } from "./messaging.service";
import { ProviderRegistry } from "./providers/provider.registry";
import { Msg91SmsProvider } from "./providers/msg91-sms.provider";
import { ResendEmailProvider } from "./providers/resend-email.provider";
import { WhatsAppCloudProvider } from "./providers/whatsapp-cloud.provider";

/**
 * Outbound delivery — the module NotificationsService's comment has been
 * pointing at.
 *
 * The three adapters are registered as providers rather than constructed inside
 * the registry so that a deployment could swap one by overriding a single Nest
 * token, and so that a test can supply a fake without touching the network.
 *
 * `MessagingService` is exported: any module that causes an event a citizen
 * should hear about — a session starting, a settlement falling due — can inject
 * it and call `dispatch`, which is documented never to throw. The emitters
 * belong with the events, exactly as they do for in-app alerts; there is no
 * central switchboard that has to know about every workflow in the platform.
 */
@Module({
  controllers: [MessagingController],
  providers: [
    MessagingService,
    ProviderRegistry,
    Msg91SmsProvider,
    WhatsAppCloudProvider,
    ResendEmailProvider,
  ],
  exports: [MessagingService],
})
export class MessagingModule {}
