import { Module } from "@nestjs/common";
import { MessagingModule } from "@/modules/messaging/messaging.module";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { OtpService } from "./otp.service";
import { TokenService } from "./token.service";

@Module({
  imports: [MessagingModule],
  controllers: [AuthController],
  providers: [AuthService, OtpService, TokenService],
  exports: [AuthService, TokenService],
})
export class AuthModule {}
