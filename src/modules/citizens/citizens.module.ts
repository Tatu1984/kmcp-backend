import { Module } from "@nestjs/common";
import { CitizensController } from "./citizens.controller";
import { CitizensService } from "./citizens.service";

@Module({
  controllers: [CitizensController],
  providers: [CitizensService],
  exports: [CitizensService],
})
export class CitizensModule {}
