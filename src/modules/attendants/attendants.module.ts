import { Module } from "@nestjs/common";
import { AttendantsController } from "./attendants.controller";
import { AttendantsService } from "./attendants.service";

@Module({
  controllers: [AttendantsController],
  providers: [AttendantsService],
  exports: [AttendantsService],
})
export class AttendantsModule {}
