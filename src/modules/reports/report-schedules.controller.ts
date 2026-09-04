import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";

import { zodPipe } from "@/common/pipes/zod-validation.pipe";
import {
  ClientInfo,
  CurrentUser,
  RequestId,
  RequirePermissions,
  type AuthenticatedUser,
} from "@/common/decorators/auth.decorators";
import { ReportSchedulesService } from "./report-schedules.service";
import {
  CreateReportScheduleSchema,
  ReportScheduleQuerySchema,
  UpdateReportScheduleSchema,
  type CreateReportScheduleDto,
  type ReportScheduleQueryDto,
  type UpdateReportScheduleDto,
} from "./dto/report-schedule.dto";

/**
 * Scheduled reports.
 *
 * Every route sits on `report.generate` — the same grant the interactive report
 * routes carry — because that is exactly what a schedule is: a request to run a
 * report, made in advance. Inventing a `report.schedule` permission would have
 * created a checkbox the seeded roles do not hold and a screen that answered
 * 403 for the officers who need it most, while defending nothing: anyone who
 * can press the button can already have the report.
 *
 * What a schedule adds is *whose* report it is, and that is enforced in the
 * service by row scope rather than by a permission — see `scopeOf`. A
 * zone-scoped caller sees and manages only their own; an unrestricted one sees
 * the authority's, exactly as the job history is scoped.
 *
 * Mounted at `/reports/schedules` and declared before `ReportsController` in
 * the module, so `GET /reports/schedules` cannot be swallowed by a future
 * `GET /reports/:id`.
 */
@ApiTags("Reports")
@ApiBearerAuth("bearer")
@Controller("reports/schedules")
export class ReportSchedulesController {
  constructor(private readonly schedules: ReportSchedulesService) {}

  @RequirePermissions("report.generate")
  @Get()
  @ApiOperation({
    summary: "Report schedules",
    description:
      "Your own, unless you hold an unrestricted role — the same line the report history draws.",
  })
  list(
    @Query(zodPipe(ReportScheduleQuerySchema)) query: ReportScheduleQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.schedules.list(query, user);
  }

  @RequirePermissions("report.generate")
  @Get(":id")
  @ApiOperation({ summary: "One schedule" })
  findOne(@Param("id") id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.schedules.findOne(id, user);
  }

  @RequirePermissions("report.generate")
  @Post()
  @ApiOperation({
    summary: "Create a schedule",
    description:
      "The owner is the signed-in account and cannot be supplied — a schedule runs as its owner, " +
      "so a recipient field would be a way to have a report produced under someone else's scope. " +
      "The recurrence is stated in local wall-clock terms and the period is derived at each run.",
  })
  create(
    @Body(zodPipe(CreateReportScheduleSchema)) dto: CreateReportScheduleDto,
    @CurrentUser() user: AuthenticatedUser,
    @ClientInfo() info: { ip?: string },
    @RequestId() requestId: string,
  ) {
    return this.schedules.create(dto, user, { ...info, requestId });
  }

  /**
   * Pausing and resuming are this route with `{ "isActive": false }` rather
   * than two more endpoints. There is nothing they would do that a patch does
   * not, and a separate verb would be a second place for the recurrence to be
   * recomputed — or forgotten.
   */
  @RequirePermissions("report.generate")
  @Patch(":id")
  @ApiOperation({
    summary: "Edit, pause or resume a schedule",
    description: "Send `isActive` alone to pause or resume. The next run is recomputed on every edit.",
  })
  update(
    @Param("id") id: string,
    @Body(zodPipe(UpdateReportScheduleSchema)) dto: UpdateReportScheduleDto,
    @CurrentUser() user: AuthenticatedUser,
    @ClientInfo() info: { ip?: string },
    @RequestId() requestId: string,
  ) {
    return this.schedules.update(id, dto, user, { ...info, requestId });
  }

  @RequirePermissions("report.generate")
  @Delete(":id")
  @ApiOperation({
    summary: "Delete a schedule",
    description:
      "The reports it already produced are untouched — a job is a record that a question was asked, " +
      "and only the intention to keep asking is removed.",
  })
  remove(
    @Param("id") id: string,
    @CurrentUser() user: AuthenticatedUser,
    @ClientInfo() info: { ip?: string },
    @RequestId() requestId: string,
  ) {
    return this.schedules.remove(id, user, { ...info, requestId });
  }

  @RequirePermissions("report.generate")
  @Post(":id/run")
  @ApiOperation({
    summary: "Run a schedule now",
    description:
      "Runs as the schedule's owner and delivers to them, which is what the button honestly means. " +
      "It does not move the next scheduled run.",
  })
  runNow(
    @Param("id") id: string,
    @CurrentUser() user: AuthenticatedUser,
    @ClientInfo() info: { ip?: string },
    @RequestId() requestId: string,
  ) {
    return this.schedules.runNow(id, user, { ...info, requestId });
  }
}
