import { Global, Module } from "@nestjs/common";
import { RolesService } from "./rbac/roles.service";
import { AuditService } from "./services/audit.service";
import { IdempotencyService } from "./services/idempotency.service";

@Global()
@Module({
  providers: [AuditService, IdempotencyService, RolesService],
  exports: [AuditService, IdempotencyService, RolesService],
})
export class CommonModule {}
