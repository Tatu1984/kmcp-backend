import { Module } from "@nestjs/common";
import { UsersController } from "./users.controller";
import { RbacController } from "./rbac.controller";
import { UsersService } from "./users.service";

@Module({
  controllers: [UsersController, RbacController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
