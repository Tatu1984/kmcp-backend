import { Controller, Get } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { PrismaService } from "@/prisma/prisma.service";
import { Public } from "@/common/decorators/auth.decorators";
import { AppException } from "@/common/errors/app.exception";
import { APP } from "@/config/app.constants";

/**
 * The commit this build was produced from.
 *
 * Vercel sets it at build time. Reporting it is what lets CI prove the deployed
 * code is the code that was pushed — a push whose deploy hook silently never
 * fired otherwise looks perfectly healthy, because the previous build is still
 * answering.
 */
const COMMIT = process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.GIT_COMMIT_SHA ?? "unknown";

@ApiTags("System")
@Controller()
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Public()
  @Get("health")
  @ApiOperation({ summary: "Liveness probe" })
  live() {
    return { status: "ok", service: "kmcp-api", version: APP.version, commit: COMMIT };
  }

  @Public()
  @Get("health/ready")
  @ApiOperation({ summary: "Readiness probe — checks the database" })
  async ready() {
    const database = await this.prisma.ping();
    if (!database) throw new AppException("SERVICE_UNAVAILABLE");
    return { status: "ready", database: "up" };
  }

  @Public()
  @Get("version")
  @ApiOperation({ summary: "Build version and minimum supported client" })
  version() {
    return {
      version: APP.version,
      commit: COMMIT,
      phase: APP.phase,
      anprEnabled: APP.anprEnabled,
      minimumClientVersion: { vendor: "1.0.0", citizen: "1.0.0" },
    };
  }
}
