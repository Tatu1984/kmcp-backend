import { Module } from "@nestjs/common";
import { RevenueController, SettlementsController } from "./settlements.controller";
import { SettlementsService } from "./settlements.service";

@Module({
  controllers: [SettlementsController, RevenueController],
  providers: [SettlementsService],
  exports: [SettlementsService],
})
export class SettlementsModule {}
