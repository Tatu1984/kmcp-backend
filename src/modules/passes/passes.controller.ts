import { Body, Controller, Get, Param, Patch, Post, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { z } from "zod";

import { zodPipe } from "@/common/pipes/zod-validation.pipe";
import {
  ClientInfo,
  CurrentUser,
  RequestId,
  RequirePermissions,
  type AuthenticatedUser,
} from "@/common/decorators/auth.decorators";
import { PassesService } from "./passes.service";
import {
  CancelPassSchema,
  CreatePassPlanSchema,
  PassPlanQuerySchema,
  PassQuerySchema,
  UpdatePassPlanSchema,
  type CancelPassDto,
  type CreatePassPlanDto,
  type PassPlanQueryDto,
  type PassQueryDto,
  type UpdatePassPlanDto,
} from "./dto/pass.dto";

const PlanStatusSchema = z.object({ isActive: z.boolean() });

/** The price card citizens buy from. */
@ApiTags("Pass plans")
@ApiBearerAuth("bearer")
@Controller("pass-plans")
export class PassPlansController {
  constructor(private readonly passes: PassesService) {}

  @RequirePermissions("tariff.read")
  @Get()
  @ApiOperation({ summary: "Pass plans, with the count of passes live against each" })
  list(@Query(zodPipe(PassPlanQuerySchema)) query: PassPlanQueryDto) {
    return this.passes.listPlans(query);
  }

  @RequirePermissions("tariff.read")
  @Get(":id")
  @ApiOperation({ summary: "One plan" })
  findOne(@Param("id") id: string) {
    return this.passes.findPlan(id);
  }

  @RequirePermissions("pass.write")
  @Post()
  @ApiOperation({
    summary: "Create a plan",
    description: "An empty zone list means city-wide, which is how the price card reads it.",
  })
  create(
    @Body(zodPipe(CreatePassPlanSchema)) dto: CreatePassPlanDto,
    @CurrentUser() user: AuthenticatedUser,
    @ClientInfo() info: { ip?: string },
    @RequestId() requestId: string,
  ) {
    return this.passes.createPlan(dto, user, { ...info, requestId });
  }

  @RequirePermissions("pass.write")
  @Patch(":id")
  @ApiOperation({
    summary: "Edit a plan",
    description: "Applies to what is sold next. Passes already issued keep the terms they were bought on.",
  })
  update(
    @Param("id") id: string,
    @Body(zodPipe(UpdatePassPlanSchema)) dto: UpdatePassPlanDto,
    @CurrentUser() user: AuthenticatedUser,
    @ClientInfo() info: { ip?: string },
    @RequestId() requestId: string,
  ) {
    return this.passes.updatePlan(id, dto, user, { ...info, requestId });
  }

  @RequirePermissions("pass.write")
  @Post(":id/status")
  @ApiOperation({
    summary: "Withdraw from sale or put back on sale",
    description: "Plans are never deleted — a live pass must still show what was bought.",
  })
  setStatus(
    @Param("id") id: string,
    @Body(zodPipe(PlanStatusSchema)) dto: { isActive: boolean },
    @CurrentUser() user: AuthenticatedUser,
    @ClientInfo() info: { ip?: string },
    @RequestId() requestId: string,
  ) {
    return this.passes.setPlanActive(id, dto.isActive, user, { ...info, requestId });
  }
}

/** One citizen's entitlement against one vehicle. */
@ApiTags("Passes")
@ApiBearerAuth("bearer")
@Controller("passes")
export class PassesController {
  constructor(private readonly passes: PassesService) {}

  @RequirePermissions("session.read")
  @Get()
  @ApiOperation({ summary: "Issued passes, filtered by status, plan, holder or expiry window" })
  list(@Query(zodPipe(PassQuerySchema)) query: PassQueryDto) {
    return this.passes.listPasses(query);
  }

  @RequirePermissions("session.read")
  @Get("summary")
  @ApiOperation({ summary: "Counts by status, those lapsing within a week, and pass revenue" })
  summary() {
    return this.passes.passSummary();
  }

  @RequirePermissions("session.read")
  @Get(":id")
  @ApiOperation({ summary: "One pass" })
  findOne(@Param("id") id: string) {
    return this.passes.findPass(id);
  }

  @RequirePermissions("pass.write")
  @Post(":id/cancel")
  @ApiOperation({
    summary: "Cancel a pass",
    description: "An expired pass is left alone — it ended on its own terms.",
  })
  cancel(
    @Param("id") id: string,
    @Body(zodPipe(CancelPassSchema)) dto: CancelPassDto,
    @CurrentUser() user: AuthenticatedUser,
    @ClientInfo() info: { ip?: string },
    @RequestId() requestId: string,
  ) {
    return this.passes.cancelPass(id, dto, user, { ...info, requestId });
  }
}
