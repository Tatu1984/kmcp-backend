import { Module } from "@nestjs/common";
import { GeographyController } from "./geography.controller";
import { GeographyService } from "./geography.service";

@Module({
  controllers: [GeographyController],
  providers: [GeographyService],
  exports: [GeographyService],
})
export class GeographyModule {}
