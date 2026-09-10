import { Module } from "@nestjs/common";
import { PaymentsModule } from "@/modules/payments/payments.module";
import { WalletController } from "./wallet.controller";
import { WalletService } from "./wallet.service";

/**
 * Imports `PaymentsModule` for `PaymentsService` (pricing a session via
 * `outstanding`, issuing receipts) and `RazorpayService` (creating top-up
 * orders) — both exported from there.
 */
@Module({
  imports: [PaymentsModule],
  controllers: [WalletController],
  providers: [WalletService],
})
export class WalletModule {}
