import { MiddlewareConsumer, Module, NestModule } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";
import { JwtModule } from "@nestjs/jwt";
import { ScheduleModule } from "@nestjs/schedule";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";

import { validateEnv, type Env } from "./config/env.config";
import { PrismaModule } from "./prisma/prisma.module";
import { CommonModule } from "./common/common.module";
import { AllExceptionsFilter } from "./common/filters/all-exceptions.filter";
import { ResponseInterceptor } from "./common/interceptors/response.interceptor";
import { RequestIdMiddleware } from "./common/middleware/request-id.middleware";
import { JwtAuthGuard } from "./common/guards/jwt-auth.guard";
import { RbacGuard } from "./common/guards/rbac.guard";
import { HealthController } from "./health/health.controller";
import { AuthModule } from "./modules/auth/auth.module";
import { ActivityModule } from "./modules/activity/activity.module";
import { ZonesModule } from "./modules/zones/zones.module";
import { TariffsModule } from "./modules/tariffs/tariffs.module";
import { VendorsModule } from "./modules/vendors/vendors.module";
import { AuditModule } from "./modules/audit/audit.module";
import { GeographyModule } from "./modules/geography/geography.module";
import { VehicleTypesModule } from "./modules/vehicle-types/vehicle-types.module";
import { SlotsModule } from "./modules/slots/slots.module";
import { AttendantsModule } from "./modules/attendants/attendants.module";
import { UsersModule } from "./modules/users/users.module";
import { SettingsModule } from "./modules/settings/settings.module";
import { MediaModule } from "./modules/media/media.module";
import { SessionsModule } from "./modules/sessions/sessions.module";
import { PaymentsModule } from "./modules/payments/payments.module";
import { ShiftsModule } from "./modules/shifts/shifts.module";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: validateEnv,
    }),
    JwtModule.registerAsync({
      global: true,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        secret: config.get("JWT_ACCESS_SECRET", { infer: true }),
        signOptions: { expiresIn: config.get("ACCESS_TOKEN_TTL", { infer: true }) },
      }),
    }),
    ThrottlerModule.forRoot([
      { name: "default", ttl: 60_000, limit: 120 },
      { name: "strict", ttl: 60_000, limit: 10 },
    ]),
    ScheduleModule.forRoot(),
    PrismaModule,
    CommonModule,
    ActivityModule,
    AuthModule,
    ZonesModule,
    TariffsModule,
    VendorsModule,
    AuditModule,
    GeographyModule,
    VehicleTypesModule,
    SlotsModule,
    AttendantsModule,
    UsersModule,
    SettingsModule,
    MediaModule,
    SessionsModule,
    PaymentsModule,
    ShiftsModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },
    // Order matters: throttle, then authenticate, then authorise.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RbacGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes("{*path}");
  }
}
