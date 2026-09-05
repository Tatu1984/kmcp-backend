import { Body, Controller, Get, Post, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";

import { zodPipe } from "@/common/pipes/zod-validation.pipe";
import {
  ClientInfo,
  CurrentUser,
  RequestId,
  RequirePermissions,
  type AuthenticatedUser,
} from "@/common/decorators/auth.decorators";
import { AttendantPaymentsService } from "./attendant-payments.service";
import {
  AttendantPaymentQuerySchema,
  CreateAttendantPaymentSchema,
  type AttendantPaymentQueryDto,
  type CreateAttendantPaymentDto,
} from "./dto/attendant-payment.dto";

/**
 * A vendor's record of paying their own staff.
 *
 * Every route here is vendor-only, and not merely by permission: the service
 * refuses any caller without a vendorId of its own, which is what keeps the
 * authority out. A superuser passes every permission check by definition, so
 * the grant below is the lock and the vendorId is the key.
 */
@ApiTags("Attendant payments")
@ApiBearerAuth("bearer")
@Controller("attendant-payments")
export class AttendantPaymentsController {
  constructor(private readonly payments: AttendantPaymentsService) {}

  @RequirePermissions("attendant.pay.read")
  @Get()
  @ApiOperation({
    summary: "Payments this vendor has made to their attendants",
    description:
      "Visible to the vendor who made them and to nobody else, the authority included.",
  })
  list(
    @Query(zodPipe(AttendantPaymentQuerySchema)) query: AttendantPaymentQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.payments.list(query, user);
  }

  @RequirePermissions("attendant.pay.read")
  @Get("summary")
  @ApiOperation({
    summary: "What has been paid out, per attendant and per method",
    description:
      "Lists every attendant on the books, including those paid nothing in the period.",
  })
  summary(
    @Query(zodPipe(AttendantPaymentQuerySchema)) query: AttendantPaymentQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.payments.summary(query, user);
  }

  @RequirePermissions("attendant.pay.write")
  @Post()
  @ApiOperation({
    summary: "Record a payment made to an attendant",
    description:
      "Records money that has already moved — cash in hand, UPI, or a bank transfer. " +
      "Anything electronic must carry its transaction reference, because a transfer " +
      "with nothing to quote cannot be reconciled against a statement later.",
  })
  create(
    @Body(zodPipe(CreateAttendantPaymentSchema)) dto: CreateAttendantPaymentDto,
    @CurrentUser() user: AuthenticatedUser,
    @ClientInfo() ip: string,
    @RequestId() requestId: string,
  ) {
    return this.payments.create(dto, user, { ip, requestId });
  }
}
