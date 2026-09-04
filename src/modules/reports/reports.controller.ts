import { Body, Controller, Get, Header, Param, Post, Query, Res } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Response } from "express";

import { zodPipe } from "@/common/pipes/zod-validation.pipe";
import {
  ClientInfo,
  CurrentUser,
  RequestId,
  RequirePermissions,
  type AuthenticatedUser,
} from "@/common/decorators/auth.decorators";
import { RawResponse } from "@/common/interceptors/response.interceptor";
import { ReportsService } from "./reports.service";
import {
  GenerateReportSchema,
  ReportQuerySchema,
  type GenerateReportDto,
  type ReportQueryDto,
} from "./dto/report.dto";

@ApiTags("Reports")
@ApiBearerAuth("bearer")
@Controller("reports")
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @RequirePermissions("report.generate")
  @Get("types")
  @ApiOperation({
    summary: "The report catalogue, as this caller may run it",
    description:
      "Served from the API so the portal cannot offer a report this cannot run — including the " +
      "three that cover the whole authority and are withheld from a zone-scoped caller.",
  })
  types(@CurrentUser() user: AuthenticatedUser) {
    return this.reports.catalogue(user);
  }

  @RequirePermissions("report.generate")
  @Get()
  @ApiOperation({ summary: "Reports that have been run" })
  list(@Query(zodPipe(ReportQuerySchema)) query: ReportQueryDto, @CurrentUser() user: AuthenticatedUser) {
    return this.reports.list(query, user);
  }

  @RequirePermissions("report.generate")
  @Post()
  @ApiOperation({
    summary: "Run a report",
    description:
      "Runs inline and returns when it is done — a serverless deployment has no worker to drain a " +
      "queue, so a job left QUEUED would sit there forever looking like a backlog.",
  })
  generate(
    @Body(zodPipe(GenerateReportSchema)) dto: GenerateReportDto,
    @CurrentUser() user: AuthenticatedUser,
    @ClientInfo() info: { ip?: string },
    @RequestId() requestId: string,
  ) {
    return this.reports.generate(dto, user, { ...info, requestId });
  }

  @RequirePermissions("report.generate")
  @RawResponse()
  @Get(":id/download")
  @Header("content-type", "text/csv; charset=utf-8")
  @ApiOperation({
    summary: "Download the report as CSV",
    description:
      "Re-runs the stored parameters, so the file can never disagree with the data it describes.",
  })
  async download(
    @Param("id") id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Res({ passthrough: true }) response: Response,
  ): Promise<string> {
    const { filename, csv } = await this.reports.download(id, user);
    response.setHeader("content-disposition", `attachment; filename="${filename}"`);
    // The response envelope is skipped here on purpose: this is a file, and a
    // spreadsheet cannot open `{ success: true, data: "..." }`.
    return csv;
  }
}
