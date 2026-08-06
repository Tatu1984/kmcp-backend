import { Module } from "@nestjs/common";
import { SessionsController } from "./sessions.controller";
import { SessionsService } from "./sessions.service";
import { OverstayTask } from "./overstay.task";
import { TariffsModule } from "@/modules/tariffs/tariffs.module";

@Module({
  imports: [TariffsModule],
  controllers: [SessionsController],
  providers: [SessionsService, OverstayTask],
  exports: [SessionsService],
})
export class SessionsModule {}
