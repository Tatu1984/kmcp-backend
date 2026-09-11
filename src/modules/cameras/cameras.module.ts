import { Module } from "@nestjs/common";
import { CamerasController } from "./cameras.controller";
import { IngestController } from "./ingest.controller";
import { CamerasService } from "./cameras.service";

@Module({
  controllers: [CamerasController, IngestController],
  providers: [CamerasService],
  exports: [CamerasService],
})
export class CamerasModule {}
