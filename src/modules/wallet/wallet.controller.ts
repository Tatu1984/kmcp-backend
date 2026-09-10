import { Body, Controller, Get, Post, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";

import { zodPipe } from "@/common/pipes/zod-validation.pipe";
import {
  ClientInfo,
  CurrentUser,
  RequestId,
  type AuthenticatedUser,
} from "@/common/decorators/auth.decorators";
import { WalletService } from "./wallet.service";
import {
  PayFromWalletSchema,
  TopUpSchema,
  WalletEntriesQuerySchema,
  type PayFromWalletDto,
  type TopUpDto,
  type WalletEntriesQueryDto,
} from "./dto/wallet.dto";

/**
 * A citizen's own wallet — balance, ledger, top-up, and paying a session out
 * of it.
 *
 * No `@RequirePermissions` anywhere in this file, deliberately, same
 * reasoning as `MeController`: a citizen viewing or spending their own
 * wallet needs nothing beyond a valid token. Every method on `WalletService`
 * is scoped to `user.id` itself, so there is no row this can expose or move
 * that does not already belong to the caller.
 */
@ApiTags("Wallet")
@ApiBearerAuth("bearer")
@Controller("me/wallet")
export class WalletController {
  constructor(private readonly wallet: WalletService) {}

  @Get()
  @ApiOperation({ summary: "This citizen's wallet balance" })
  balance(@CurrentUser() user: AuthenticatedUser) {
    return this.wallet.balance(user);
  }

  @Get("entries")
  @ApiOperation({ summary: "This citizen's wallet ledger, newest first" })
  entries(
    @Query(zodPipe(WalletEntriesQuerySchema)) query: WalletEntriesQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.wallet.entries(query, user);
  }

  @Post("topups")
  @ApiOperation({
    summary: "Start a wallet top-up",
    description:
      "Creates a gateway order for the requested amount. The wallet is credited when Razorpay's " +
      "webhook confirms the capture, not by this call.",
  })
  topUp(
    @Body(zodPipe(TopUpSchema)) dto: TopUpDto,
    @CurrentUser() user: AuthenticatedUser,
    @ClientInfo() info: { ip?: string },
    @RequestId() requestId: string,
  ) {
    return this.wallet.topUp(dto, user, { ...info, requestId });
  }

  @Post("payments")
  @ApiOperation({
    summary: "Pay for a parking session from the wallet balance",
    description:
      "No gateway or checkout involved. The amount is whatever the session still owes — it cannot " +
      "be supplied — and the debit is refused if the balance does not cover it.",
  })
  payFromWallet(
    @Body(zodPipe(PayFromWalletSchema)) dto: PayFromWalletDto,
    @CurrentUser() user: AuthenticatedUser,
    @ClientInfo() info: { ip?: string },
    @RequestId() requestId: string,
  ) {
    return this.wallet.payFromWallet(dto, user, { ...info, requestId });
  }
}
