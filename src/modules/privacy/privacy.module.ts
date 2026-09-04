import { Module } from "@nestjs/common";

import { MediaModule } from "@/modules/media/media.module";
import { PrivacyController } from "./privacy.controller";
import { RetentionService } from "./retention.service";
import { SubjectRightsService } from "./subject-rights.service";
import { ConsentService } from "./consent.service";

/**
 * The data-protection layer: retention, subject rights and consent.
 *
 * `MediaModule` is imported for one method — `discardObjects` — because
 * expiring an evidence photograph means deleting bytes from a bucket as well as
 * a row from a table, and the S3 client lives there. Everything else this
 * module needs is either global (`PrismaService`, `AuditService`) or its own.
 *
 * `RetentionService` is exported because the cron controller drives the sweep,
 * and `ConsentService` because `ActivityService` writes a ledger entry every
 * time somebody answers the location prompt.
 */
@Module({
  imports: [MediaModule],
  controllers: [PrivacyController],
  providers: [RetentionService, SubjectRightsService, ConsentService],
  exports: [RetentionService, ConsentService],
})
export class PrivacyModule {}
