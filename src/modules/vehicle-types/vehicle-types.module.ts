import { Module } from "@nestjs/common";
import { VehicleTypesController } from "./vehicle-types.controller";

@Module({ controllers: [VehicleTypesController] })
export class VehicleTypesModule {}
