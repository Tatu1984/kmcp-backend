import { Body, Controller, Get, Param, Post, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";

import { zodPipe } from "@/common/pipes/zod-validation.pipe";
import {
  ClientInfo,
  CurrentUser,
  IdempotencyKey,
  RequestId,
  RequirePermissions,
  type AuthenticatedUser,
} from "@/common/decorators/auth.decorators";
import { SettlementsService } from "./settlements.service";
import {
  GenerateSettlementSchema,
  PayoutSettlementSchema,
  RejectSettlementSchema,
  RevenueQuerySchema,
  SettlementQuerySchema,
  type GenerateSettlementDto,
  type PayoutSettlementDto,
  type RejectSettlementDto,
  type RevenueQueryDto,
  type SettlementQueryDto,
} from "./dto/settlement.dto";

@ApiTags("Settlements")
@ApiBearerAuth("bearer")
@Controller("settlements")
export class SettlementsController {
  constructor(private readonly settlements: SettlementsService) {}

  @RequirePermissions("settlement.read")
  @Get()
  @ApiOperation({ summary: "Settlements, filtered by status, vendor or period" })
  list(
    @Query(zodPipe(SettlementQuerySchema)) query: SettlementQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.settlements.list(query, user);
  }

  @RequirePermissions("settlement.read")
  @Get("summary")
  @ApiOperation({ summary: "Totals by status, and what is approved but still unpaid" })
  summary(@CurrentUser() user: AuthenticatedUser) {
    return this.settlements.summary(user);
  }

  @RequirePermissions("settlement.read")
  @Get(":id")
  @ApiOperation({ summary: "One settlement with its lines and ledger postings" })
  findOne(@Param("id") id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.settlements.findOne(id, user);
  }

  @RequirePermissions("settlement.read")
  @Post("generate")
  @ApiOperation({
    summary: "Build a draft settlement for a vendor and period",
    description:
      "Sweeps in every captured payment in the period that no settlement has claimed yet, so a " +
      "re-run after a late webhook picks up stragglers rather than paying twice.",
  })
  generate(
    @Body(zodPipe(GenerateSettlementSchema)) dto: GenerateSettlementDto,
    @CurrentUser() user: AuthenticatedUser,
    @ClientInfo() info: { ip?: string },
    @RequestId() requestId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
  ) {
    return this.settlements.generate(dto, user, { ...info, requestId, idempotencyKey });
  }

  @RequirePermissions("settlement.read")
  @Post(":id/submit")
  @ApiOperation({ summary: "Send a draft up for approval" })
  submit(
    @Param("id") id: string,
    @CurrentUser() user: AuthenticatedUser,
    @ClientInfo() info: { ip?: string },
    @RequestId() requestId: string,
  ) {
    return this.settlements.submit(id, user, { ...info, requestId });
  }

  @RequirePermissions("settlement.approve")
  @Post(":id/approve")
  @ApiOperation({
    summary: "Approve and post to the ledger",
    description: "Debits and credits must balance or nothing is written.",
  })
  approve(
    @Param("id") id: string,
    @CurrentUser() user: AuthenticatedUser,
    @ClientInfo() info: { ip?: string },
    @RequestId() requestId: string,
  ) {
    return this.settlements.approve(id, user, { ...info, requestId });
  }

  @RequirePermissions("settlement.approve")
  @Post(":id/reject")
  @ApiOperation({ summary: "Send it back with a reason" })
  reject(
    @Param("id") id: string,
    @Body(zodPipe(RejectSettlementSchema)) dto: RejectSettlementDto,
    @CurrentUser() user: AuthenticatedUser,
    @ClientInfo() info: { ip?: string },
    @RequestId() requestId: string,
  ) {
    return this.settlements.reject(id, dto, user, { ...info, requestId });
  }

  @RequirePermissions("settlement.payout")
  @Post(":id/payout")
  @ApiOperation({
    summary: "Record that the vendor has been paid",
    description:
      "Records a transfer made at the bank against its reference. It does not move money — " +
      "RazorpayX credentials do not exist yet, and this is the fallback for when the gateway is down.",
  })
  payout(
    @Param("id") id: string,
    @Body(zodPipe(PayoutSettlementSchema)) dto: PayoutSettlementDto,
    @CurrentUser() user: AuthenticatedUser,
    @ClientInfo() info: { ip?: string },
    @RequestId() requestId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
  ) {
    return this.settlements.payout(id, dto, user, { ...info, requestId, idempotencyKey });
  }
}

/** Takings, read from the payments rather than from settlement paperwork. */
@ApiTags("Revenue")
@ApiBearerAuth("bearer")
@Controller("revenue")
export class RevenueController {
  constructor(private readonly settlements: SettlementsService) {}

  @RequirePermissions("payment.read")
  @Get()
  @ApiOperation({
    summary: "Revenue by day, zone, vendor and payment method",
    description: "Counted from money received, not from settlements run — the two differ by admin lag.",
  })
  revenue(
    @Query(zodPipe(RevenueQuerySchema)) query: RevenueQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.settlements.revenue(query, user);
  }
}
