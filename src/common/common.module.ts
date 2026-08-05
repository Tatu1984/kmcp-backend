import { Global, Module } from "@nestjs/common";
import { AuditService } from "./services/audit.service";
import { IdempotencyService } from "./services/idempotency.service";

@Global()
@Module({
  providers: [AuditService, IdempotencyService],
  exports: [AuditService, IdempotencyService],
})
export class CommonModule {}
