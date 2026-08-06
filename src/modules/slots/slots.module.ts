import { Module } from "@nestjs/common";
import { SlotsController } from "./slots.controller";
import { SlotsService } from "./slots.service";

@Module({
  controllers: [SlotsController],
  providers: [SlotsService],
  exports: [SlotsService],
})
export class SlotsModule {}
