import { Module } from "@nestjs/common";
import { AttendantPaymentsController } from "./attendant-payments.controller";
import { AttendantPaymentsService } from "./attendant-payments.service";

@Module({
  controllers: [AttendantPaymentsController],
  providers: [AttendantPaymentsService],
  exports: [AttendantPaymentsService],
})
export class AttendantPaymentsModule {}
