import { Module } from "@nestjs/common";
import { MeModule } from "@/modules/me/me.module";
import { PaymentsModule } from "@/modules/payments/payments.module";
import { PassPlansController, PassesController, MyPassesController } from "./passes.controller";
import { PassesService } from "./passes.service";

@Module({
  imports: [MeModule, PaymentsModule],
  controllers: [PassPlansController, PassesController, MyPassesController],
  providers: [PassesService],
  exports: [PassesService],
})
export class PassesModule {}
