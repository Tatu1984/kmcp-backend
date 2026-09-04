import { Controller, Get, Param, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";

import { zodPipe } from "@/common/pipes/zod-validation.pipe";
import {
  ClientInfo,
  CurrentUser,
  RequestId,
  RequirePermissions,
  type AuthenticatedUser,
} from "@/common/decorators/auth.decorators";
import { DocumentsService } from "./documents.service";
import { AuditTrailQuerySchema, type AuditTrailQueryDto } from "./dto/document.dto";

/**
 * Rendered documents.
 *
 * The routes live together rather than on the four resources they describe,
 * because what they share — content-addressed storage, the reuse rule, the
 * signed-URL response shape — matters more than proximity to a list endpoint.
 * Each one still takes the grant its own resource takes, read off the
 * neighbouring routes rather than invented here:
 *
 *   - a receipt is `payment.read`, as `POST /payments/:id/receipt` is;
 *   - a settlement statement is `settlement.read`, as `GET /settlements/:id`
 *     is — deliberately not `settlement.approve`, since reading the paperwork
 *     is not signing it off;
 *   - a shift slip is `session.read`, as every read route on `/shifts` is;
 *     `shift.verify` guards the act of confirming the cash, not printing the
 *     slip somebody signs;
 *   - signage is `zone.read`, as `GET /zones/:id` is;
 *   - the audit export is `audit.read`, as every route on `/audit` is.
 *
 * None of these returns the file. Each returns a short-lived signed URL for the
 * stored document, which is the only form in which the per-file read rule in
 * MediaAccessService can apply.
 */
@ApiTags("Documents")
@ApiBearerAuth("bearer")
@Controller("documents")
export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  @RequirePermissions("payment.read")
  @Get("receipts/:paymentId")
  @ApiOperation({
    summary: "The parking receipt for a payment, as a PDF",
    description:
      "Rendered from the stored session and payment rows — never re-priced. Returns the file " +
      "already held for this record unless the record has changed since.",
  })
  receipt(
    @Param("paymentId") paymentId: string,
    @CurrentUser() user: AuthenticatedUser,
    @ClientInfo() info: { ip?: string },
    @RequestId() requestId: string,
  ) {
    return this.documents.receipt(paymentId, user, { ...info, requestId });
  }

  @RequirePermissions("settlement.read")
  @Get("settlements/:id")
  @ApiOperation({
    summary: "The settlement statement, as a PDF",
    description:
      "Refused if the settlement's totals do not reconcile to its own payment lines. A statement " +
      "that does not add up is worse than none.",
  })
  settlement(
    @Param("id") id: string,
    @CurrentUser() user: AuthenticatedUser,
    @ClientInfo() info: { ip?: string },
    @RequestId() requestId: string,
  ) {
    return this.documents.settlementStatement(id, user, { ...info, requestId });
  }

  @RequirePermissions("session.read")
  @Get("shifts/:id")
  @ApiOperation({
    summary: "The cash-handover slip for a shift, as a PDF",
    description: "Carries the expected, declared and variance figures, and both signature blocks.",
  })
  shift(
    @Param("id") id: string,
    @CurrentUser() user: AuthenticatedUser,
    @ClientInfo() info: { ip?: string },
    @RequestId() requestId: string,
  ) {
    return this.documents.shiftSlip(id, user, { ...info, requestId });
  }

  @RequirePermissions("zone.read")
  @Get("zones/:id/signage")
  @ApiOperation({
    summary: "The printable tariff board for a zone, as an A4 PDF",
    description:
      "Shows only published rates in force, resolved the way the fare engine resolves them, plus " +
      "the zone's QR code.",
  })
  signage(
    @Param("id") id: string,
    @CurrentUser() user: AuthenticatedUser,
    @ClientInfo() info: { ip?: string },
    @RequestId() requestId: string,
  ) {
    return this.documents.zoneSignage(id, user, { ...info, requestId });
  }

  @RequirePermissions("audit.read")
  @Get("audit-trail")
  @ApiOperation({
    summary: "The audit trail for a period, as a PDF",
    description:
      "Carries a SHA-256 of its own contents on every page, recorded in the audit trail at the " +
      "moment of generation. Not cryptographically signed, and the document says so.",
  })
  auditTrail(
    @Query(zodPipe(AuditTrailQuerySchema)) query: AuditTrailQueryDto,
    @CurrentUser() user: AuthenticatedUser,
    @ClientInfo() info: { ip?: string },
    @RequestId() requestId: string,
  ) {
    return this.documents.auditTrail(query, user, { ...info, requestId });
  }
}
