import { Controller, Get, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { z } from "zod";

import { zodPipe } from "@/common/pipes/zod-validation.pipe";
import {
  CurrentUser,
  RequirePermissions,
  type AuthenticatedUser,
} from "@/common/decorators/auth.decorators";
import { AnalyticsService } from "./analytics.service";

const HourlyQuery = z.object({ date: z.coerce.date().optional() });
const DailyQuery = z.object({ days: z.coerce.number().int().min(1).max(90).default(30) });
const TopZonesQuery = z.object({ limit: z.coerce.number().int().min(1).max(50).default(6) });
const FeedQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(40) });

@ApiTags("Analytics")
@ApiBearerAuth("bearer")
@Controller("analytics")
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @RequirePermissions("session.read")
  @Get("overview")
  @ApiOperation({
    summary: "Everything the dashboard shows, counted at read time",
    description: "No roll-up columns — a stale counter on a dashboard is worse than a slow one.",
  })
  overview(@CurrentUser() user: AuthenticatedUser) {
    return this.analytics.overview(user);
  }

  @RequirePermissions("session.read")
  @Get("series/hourly")
  @ApiOperation({
    summary: "Today by the hour — vehicles parked and sessions started",
    description: "Occupancy counts overlap, so a long stay appears in every hour it covered.",
  })
  hourly(
    @Query(zodPipe(HourlyQuery)) query: { date?: Date },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.analytics.hourly(user, query.date);
  }

  @RequirePermissions("session.read")
  @Get("series/daily")
  @ApiOperation({ summary: "Cash, digital and session count per day" })
  daily(@Query(zodPipe(DailyQuery)) query: { days: number }, @CurrentUser() user: AuthenticatedUser) {
    return this.analytics.daily(user, query.days);
  }

  @RequirePermissions("session.read")
  @Get("feed")
  @ApiOperation({
    summary: "What has just happened — sessions, payments, incidents and shifts",
    description: "Merged from the tables that own each fact; there is no separate event log.",
  })
  feed(@Query(zodPipe(FeedQuery)) query: { limit: number }, @CurrentUser() user: AuthenticatedUser) {
    return this.analytics.feed(user, query.limit);
  }

  @RequirePermissions("session.read")
  @Get("zones/top")
  @ApiOperation({ summary: "Zones ranked by today's takings, with live occupancy" })
  topZones(
    @Query(zodPipe(TopZonesQuery)) query: { limit: number },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.analytics.topZones(user, query.limit);
  }
}
