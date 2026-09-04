import { Body, Controller, Get, Param, Post, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";

import { zodPipe } from "@/common/pipes/zod-validation.pipe";
import {
  ClientInfo,
  CurrentUser,
  RequestId,
  RequirePermissions,
  type AuthenticatedUser,
} from "@/common/decorators/auth.decorators";
import { describeTemplates } from "./templates/message-templates";
import { MessagingService } from "./messaging.service";
import {
  DeliveryQuerySchema,
  EmailReportSchema,
  SendAnnouncementSchema,
  SendPassSchema,
  SendReceiptSchema,
  type DeliveryQueryDto,
  type EmailReportDto,
  type SendAnnouncementDto,
  type SendPassDto,
  type SendReceiptDto,
} from "./dto/messaging.dto";

/**
 * Sending messages, and finding out what happened to them.
 *
 * Every permission below is one that already exists and is already enforced on
 * the equivalent route elsewhere, rather than a new `message.send` grant that
 * would have to be added to every role before anything worked. The reasoning is
 * that sending a document is not a separate power from producing it: whoever
 * may read a payment may re-send its receipt (`payment.read`, as on
 * `POST /payments/:id/receipt`); whoever may manage passes may send one
 * (`pass.write`); whoever may manage users may address the public
 * (`user.manage`, as on the citizen status routes); whoever may generate a
 * report may have it mailed to themselves (`report.generate`).
 *
 * The delivery log sits on `audit.read`, because "was this receipt actually
 * sent, and when" is an audit question and is answered from a trail nobody
 * should be able to read casually — it names, in masked form, who was contacted.
 */
@ApiTags("Messaging")
@ApiBearerAuth("bearer")
@Controller("messaging")
export class MessagingController {
  constructor(private readonly messaging: MessagingService) {}

  @Get("channels")
  @ApiOperation({
    summary: "Which channels this deployment can send on",
    description:
      "Undecorated on purpose: it names no person and holds no personal data, and any signed-in " +
      "portal user needs it to decide whether to offer 'By WhatsApp' at all rather than offering " +
      "it and reporting a failure they can do nothing about.",
  })
  channels() {
    return {
      channels: this.messaging.channelStatus(),
      templates: describeTemplates(),
    };
  }

  @RequirePermissions("payment.read")
  @Post("receipts")
  @ApiOperation({
    summary: "Send or re-send a receipt",
    description:
      "Takes payment ids, session ids, or both. Only captured payments that already carry a " +
      "receipt number are sent — this never issues one, because a receipt number appearing twice " +
      "is an audit finding.",
  })
  sendReceipts(
    @Body(zodPipe(SendReceiptSchema)) dto: SendReceiptDto,
    @CurrentUser() user: AuthenticatedUser,
    @ClientInfo() info: { ip?: string },
    @RequestId() requestId: string,
  ) {
    return this.messaging.sendReceipts(dto, user, { ...info, requestId });
  }

  @RequirePermissions("pass.write")
  @Post("passes")
  @ApiOperation({
    summary: "Send a pass to its holder, or prompt them to renew",
    description:
      "`kind: issued` sends the pass code; `kind: renewal` prompts a purchase. Renewing is a " +
      "purchase the holder makes in the app, so this prompts — it does not renew.",
  })
  sendPasses(
    @Body(zodPipe(SendPassSchema)) dto: SendPassDto,
    @CurrentUser() user: AuthenticatedUser,
    @ClientInfo() info: { ip?: string },
    @RequestId() requestId: string,
  ) {
    return this.messaging.sendPasses(dto, user, { ...info, requestId });
  }

  @RequirePermissions("user.manage")
  @Post("announcements")
  @ApiOperation({
    summary: "Send an announcement to selected citizens",
    description:
      "Recipients are filtered to the CITIZEN role, so this cannot be turned on staff. The text " +
      "is recorded in the audit trail — an officer is answerable for what they sent.",
  })
  sendAnnouncement(
    @Body(zodPipe(SendAnnouncementSchema)) dto: SendAnnouncementDto,
    @CurrentUser() user: AuthenticatedUser,
    @ClientInfo() info: { ip?: string },
    @RequestId() requestId: string,
  ) {
    return this.messaging.sendAnnouncement(dto, user, { ...info, requestId });
  }

  @RequirePermissions("report.generate")
  @Post("reports/email")
  @ApiOperation({
    summary: "Email a finished report to yourself",
    description:
      "To the signed-in account and no other. There is deliberately no recipient field: one would " +
      "be an export route for a spreadsheet of plate numbers.",
  })
  emailReport(
    @Body(zodPipe(EmailReportSchema)) dto: EmailReportDto,
    @CurrentUser() user: AuthenticatedUser,
    @ClientInfo() info: { ip?: string },
    @RequestId() requestId: string,
  ) {
    return this.messaging.emailReport(dto, user, { ...info, requestId });
  }

  @RequirePermissions("audit.read")
  @Get("deliveries")
  @ApiOperation({
    summary: "The delivery log",
    description:
      "One row per recipient per channel, with the provider's own reference and the reason for " +
      "any failure. Recipient addresses are masked; this answers whether a message was sent, not " +
      "who to contact.",
  })
  deliveries(@Query(zodPipe(DeliveryQuerySchema)) query: DeliveryQueryDto) {
    return this.messaging.deliveries(query);
  }

  @RequirePermissions("audit.read")
  @Get("deliveries/:id")
  @ApiOperation({ summary: "One delivery" })
  delivery(@Param("id") id: string) {
    return this.messaging.delivery(id);
  }
}
