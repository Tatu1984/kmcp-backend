import { Module } from "@nestjs/common";
import { PaymentsController, PaymentWebhookController } from "./payments.controller";
import { PaymentsService } from "./payments.service";
import { RazorpayService } from "./razorpay.service";

@Module({
  controllers: [PaymentsController, PaymentWebhookController],
  providers: [PaymentsService, RazorpayService],
  exports: [PaymentsService],
})
export class PaymentsModule {}
