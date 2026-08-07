import { Body, Controller, Get, Param, Post, Query, Req } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { z } from "zod";
import type { Request } from "express";

import { zodPipe } from "@/common/pipes/zod-validation.pipe";
import {
  ClientInfo,
  CurrentUser,
  Public,
  RequestId,
  RequirePermissions,
  type AuthenticatedUser,
} from "@/common/decorators/auth.decorators";
import { AppException } from "@/common/errors/app.exception";
import { PaymentsService } from "./payments.service";
import {
  CollectPaymentSchema,
  PaymentQuerySchema,
  RefundPaymentSchema,
  VerifyPaymentSchema,
  type CollectPaymentDto,
  type PaymentQueryDto,
  type RefundPaymentDto,
  type VerifyPaymentDto,
} from "./dto/payment.dto";

const SummaryQuery = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

@ApiTags("Payments")
@ApiBearerAuth("bearer")
@Controller("payments")
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @RequirePermissions("payment.read")
  @Get()
  @ApiOperation({ summary: "Payments, filtered by status, mode, session, shift or date" })
  list(@Query(zodPipe(PaymentQuerySchema)) query: PaymentQueryDto, @CurrentUser() user: AuthenticatedUser) {
    return this.payments.list(query, user);
  }

  @RequirePermissions("payment.read")
  @Get("summary")
  @ApiOperation({
    summary: "Collection totals",
    description: "Split cash against digital — one is money someone is still holding, the other is banked.",
  })
  summary(
    @Query(zodPipe(SummaryQuery)) query: { from?: Date; to?: Date },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.payments.summary(user, query.from, query.to);
  }

  @RequirePermissions("payment.read")
  @Get(":id")
  @ApiOperation({ summary: "One payment with its receipt" })
  findOne(@Param("id") id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.payments.findOne(id, user);
  }

  // Attendants collect at the kerb, so this sits on session.read rather than a
  // write grant. The amount is never taken from the caller.
  @RequirePermissions("session.read")
  @Post("collect")
  @ApiOperation({
    summary: "Collect payment for a session",
    description:
      "Cash is captured immediately. Every other mode creates a gateway order and stays PENDING until " +
      "Razorpay confirms it. The amount is whatever the session still owes — it cannot be supplied.",
  })
  collect(
    @Body(zodPipe(CollectPaymentSchema)) dto: CollectPaymentDto,
    @CurrentUser() user: AuthenticatedUser,
    @ClientInfo() info: { ip?: string },
    @RequestId() requestId: string,
  ) {
    return this.payments.collect(dto, user, { ...info, requestId });
  }

  @RequirePermissions("session.read")
  @Post(":id/verify")
  @ApiOperation({
    summary: "Confirm a completed checkout",
    description:
      "Checked against a signature the client could not have produced. The webhook is still the " +
      "authority; this exists so the payer sees a receipt without waiting for it.",
  })
  verify(
    @Param("id") id: string,
    @Body(zodPipe(VerifyPaymentSchema)) dto: VerifyPaymentDto,
    @CurrentUser() user: AuthenticatedUser,
    @ClientInfo() info: { ip?: string },
    @RequestId() requestId: string,
  ) {
    return this.payments.verify(id, dto, user, { ...info, requestId });
  }

  @RequirePermissions("payment.refund")
  @Post(":id/refund")
  @ApiOperation({
    summary: "Refund a captured payment",
    description:
      "Partial or full. Cash refunds are recorded here and settled at the counter — the money never " +
      "went through the gateway, so it cannot come back through it.",
  })
  refund(
    @Param("id") id: string,
    @Body(zodPipe(RefundPaymentSchema)) dto: RefundPaymentDto,
    @CurrentUser() user: AuthenticatedUser,
    @ClientInfo() info: { ip?: string },
    @RequestId() requestId: string,
  ) {
    return this.payments.refund(id, dto, user, { ...info, requestId });
  }

  @RequirePermissions("payment.read")
  @Post(":id/receipt")
  @ApiOperation({
    summary: "Issue or fetch the receipt for a payment",
    description: "Never reissued — a receipt number appearing twice is an audit finding.",
  })
  receipt(@Param("id") id: string) {
    return this.payments.issueReceipt(id);
  }
}

/**
 * Razorpay's own account of what happened.
 *
 * Public because Razorpay has no bearer token, and authenticated by signature
 * instead — which is stronger: it proves the exact bytes came from Razorpay,
 * not merely that the caller holds a credential.
 */
@ApiTags("Webhooks")
@Controller("webhooks")
export class PaymentWebhookController {
  constructor(private readonly payments: PaymentsService) {}

  @Public()
  @Post("razorpay")
  @ApiOperation({
    summary: "Razorpay payment events",
    description: "Signature-verified and idempotent. Razorpay retries until it receives a 2xx.",
  })
  async razorpay(@Req() request: Request & { rawBody?: Buffer }) {
    const signature = request.header("x-razorpay-signature");
    if (!signature) {
      throw new AppException("PAYMENT_SIGNATURE_INVALID", [
        { field: "x-razorpay-signature", issue: "missing" },
      ]);
    }

    // The raw bytes, not the parsed object: re-serialising would change the
    // whitespace and the signature would never match.
    const raw = request.rawBody ?? Buffer.from(JSON.stringify(request.body ?? {}));
    return this.payments.handleWebhook(raw, signature, request.body as Record<string, unknown>);
  }
}
