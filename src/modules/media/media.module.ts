import { Module } from "@nestjs/common";
import { MediaController } from "./media.controller";
import { MediaService } from "./media.service";
import { MediaAccessService } from "./media-access.service";

@Module({
  controllers: [MediaController],
  providers: [MediaService, MediaAccessService],
  exports: [MediaService, MediaAccessService],
})
export class MediaModule {}
