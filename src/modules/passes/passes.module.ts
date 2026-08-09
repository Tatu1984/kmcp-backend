import { Module } from "@nestjs/common";
import { PassPlansController, PassesController } from "./passes.controller";
import { PassesService } from "./passes.service";

@Module({
  controllers: [PassPlansController, PassesController],
  providers: [PassesService],
  exports: [PassesService],
})
export class PassesModule {}
