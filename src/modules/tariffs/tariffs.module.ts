import { Module } from "@nestjs/common";
import { TariffsController } from "./tariffs.controller";
import { TariffsService } from "./tariffs.service";
import { QuoteService } from "./quote.service";

@Module({
  controllers: [TariffsController],
  providers: [TariffsService, QuoteService],
  exports: [TariffsService, QuoteService],
})
export class TariffsModule {}
