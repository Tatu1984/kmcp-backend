import { Module } from "@nestjs/common";
import { MeController } from "./me.controller";
import { MeService } from "./me.service";

/**
 * Exports `MeService` — pass purchase (and anything else that needs "resolve
 * or claim a vehicle by plate for the signed-in citizen") injects it directly
 * rather than duplicating `resolveOrClaimVehicle`.
 */
@Module({
  controllers: [MeController],
  providers: [MeService],
  exports: [MeService],
})
export class MeModule {}
