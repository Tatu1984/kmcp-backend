import { Module } from "@nestjs/common";
import { CamerasController } from "./cameras.controller";
import { CamerasService } from "./cameras.service";
import { StreamGatewayService } from "./streaming/stream-gateway.service";

@Module({
  controllers: [CamerasController],
  providers: [CamerasService, StreamGatewayService],
  exports: [CamerasService],
})
export class CamerasModule {}
