import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from "@nestjs/common";
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
import { TariffsService } from "./tariffs.service";
import {
  ApplicableTariffSchema,
  CreateDiscountSchema,
  CreateHolidaySchema,
  CreateTariffSchema,
  PreviewQuoteSchema,
  PublishTariffSchema,
  TariffQuerySchema,
  UpdateTariffSchema,
  type ApplicableTariffDto,
  type CreateDiscountDto,
  type CreateHolidayDto,
  type CreateTariffDto,
  type PreviewQuoteDto,
  type PublishTariffDto,
  type TariffQueryDto,
  type UpdateTariffDto,
} from "./dto/tariff.dto";

const ArchiveSchema = z.object({ reason: z.string().trim().min(4).max(500) });
const ToggleSchema = z.object({ isActive: z.boolean() });

@ApiTags("Tariffs")
@ApiBearerAuth("bearer")
@Controller()
export class TariffsController {
  constructor(private readonly tariffs: TariffsService) {}

  // ------------------------------------------------------------- tariffs

  @RequirePermissions("tariff.read")
  @Get("tariffs")
  @ApiOperation({ summary: "List rate cards" })
  list(@Query(zodPipe(TariffQuerySchema)) query: TariffQueryDto) {
    return this.tariffs.list(query);
  }

  // Sits on session.read, not tariff.read: this is what a handset at the kerb
  // reads, and an attendant is not a tariff administrator. It was gated behind
  // a permission attendants do not hold, which made the vendor app unable to
  // fetch the very rate card this endpoint exists to give it.
  @RequirePermissions("session.read")
  @Get("tariffs/applicable")
  @ApiOperation({
    summary: "The rate that applies to a zone and vehicle type right now",
    description:
      "What the attendant app shows before starting a session, and caches so it can still quote a " +
      "provisional fare with no signal. The server remains the authority on price.",
  })
  applicable(@Query(zodPipe(ApplicableTariffSchema)) query: ApplicableTariffDto) {
    return this.tariffs.applicable(query.zoneId, query.vehicleType, query.at);
  }

  @RequirePermissions("tariff.read")
  @Post("tariffs/preview")
  @ApiOperation({
    summary: "Simulate a fare without a session",
    description:
      "Runs the same computation a live session does, so an officer can see the effect of a rule " +
      "change before publishing it.",
  })
  preview(@Body(zodPipe(PreviewQuoteSchema)) dto: PreviewQuoteDto) {
    return this.tariffs.preview(dto);
  }

  @RequirePermissions("tariff.read")
  @Get("tariffs/:id")
  @ApiOperation({ summary: "One rate card with its rules" })
  findOne(@Param("id") id: string) {
    return this.tariffs.findOne(id);
  }

  @RequirePermissions("tariff.write")
  @Post("tariffs")
  @ApiOperation({ summary: "Draft a rate card" })
  create(
    @Body(zodPipe(CreateTariffSchema)) dto: CreateTariffDto,
    @CurrentUser() user: AuthenticatedUser,
    @ClientInfo() info: { ip?: string },
    @RequestId() requestId: string,
  ) {
    return this.tariffs.create(dto, user, { ...info, requestId });
  }

  @RequirePermissions("tariff.write")
  @Patch("tariffs/:id")
  @ApiOperation({
    summary: "Edit a draft",
    description: "Published versions are immutable — duplicate one to make changes.",
  })
  update(
    @Param("id") id: string,
    @Body(zodPipe(UpdateTariffSchema)) dto: UpdateTariffDto,
    @CurrentUser() user: AuthenticatedUser,
    @ClientInfo() info: { ip?: string },
    @RequestId() requestId: string,
  ) {
    return this.tariffs.update(id, dto, user, { ...info, requestId });
  }

  @RequirePermissions("tariff.write")
  @Post("tariffs/:id/duplicate")
  @ApiOperation({ summary: "Copy a rate card into a new draft version" })
  duplicate(
    @Param("id") id: string,
    @CurrentUser() user: AuthenticatedUser,
    @ClientInfo() info: { ip?: string },
    @RequestId() requestId: string,
  ) {
    return this.tariffs.duplicate(id, user, { ...info, requestId });
  }

  @RequirePermissions("tariff.publish")
  @Post("tariffs/:id/publish")
  @ApiOperation({
    summary: "Publish a rate card",
    description:
      "Makes it live at the kerb from its effective date, for every app, with no release needed. " +
      "Requires an approval reference, which is written to the audit trail.",
  })
  publish(
    @Param("id") id: string,
    @Body(zodPipe(PublishTariffSchema)) dto: PublishTariffDto,
    @CurrentUser() user: AuthenticatedUser,
    @ClientInfo() info: { ip?: string },
    @RequestId() requestId: string,
  ) {
    return this.tariffs.publish(id, dto, user, { ...info, requestId });
  }

  @RequirePermissions("tariff.write")
  @Delete("tariffs/:id")
  @ApiOperation({ summary: "Archive a version by closing its effective window" })
  archive(
    @Param("id") id: string,
    @Body(zodPipe(ArchiveSchema)) dto: { reason: string },
    @CurrentUser() user: AuthenticatedUser,
    @ClientInfo() info: { ip?: string },
    @RequestId() requestId: string,
  ) {
    return this.tariffs.archive(id, dto.reason, user, { ...info, requestId });
  }

  // ------------------------------------------------------------ holidays

  // Also readable from the kerb: without the calendar a cached rate card would
  // miss holiday surcharges and quote under the real fare.
  @RequirePermissions("session.read")
  @Get("holidays")
  @ApiOperation({ summary: "Holiday and event calendar" })
  listHolidays() {
    return this.tariffs.listHolidays();
  }

  @RequirePermissions("discount.write")
  @Post("holidays")
  @ApiOperation({ summary: "Add a holiday or event date" })
  createHoliday(
    @Body(zodPipe(CreateHolidaySchema)) dto: CreateHolidayDto,
    @CurrentUser() user: AuthenticatedUser,
    @ClientInfo() info: { ip?: string },
    @RequestId() requestId: string,
  ) {
    return this.tariffs.createHoliday(dto, user, { ...info, requestId });
  }

  @RequirePermissions("discount.write")
  @Delete("holidays/:id")
  @ApiOperation({ summary: "Remove a holiday" })
  removeHoliday(
    @Param("id") id: string,
    @CurrentUser() user: AuthenticatedUser,
    @ClientInfo() info: { ip?: string },
    @RequestId() requestId: string,
  ) {
    return this.tariffs.removeHoliday(id, user, { ...info, requestId });
  }

  // ----------------------------------------------------------- discounts

  @RequirePermissions("tariff.read")
  @Get("discounts")
  @ApiOperation({ summary: "Discount rules" })
  listDiscounts() {
    return this.tariffs.listDiscounts();
  }

  @RequirePermissions("discount.write")
  @Post("discounts")
  @ApiOperation({ summary: "Create a discount rule" })
  createDiscount(
    @Body(zodPipe(CreateDiscountSchema)) dto: CreateDiscountDto,
    @CurrentUser() user: AuthenticatedUser,
    @ClientInfo() info: { ip?: string },
    @RequestId() requestId: string,
  ) {
    return this.tariffs.createDiscount(dto, user, { ...info, requestId });
  }

  @RequirePermissions("discount.write")
  @Patch("discounts/:id")
  @ApiOperation({ summary: "Pause or resume a discount" })
  toggleDiscount(
    @Param("id") id: string,
    @Body(zodPipe(ToggleSchema)) dto: { isActive: boolean },
    @CurrentUser() user: AuthenticatedUser,
    @ClientInfo() info: { ip?: string },
    @RequestId() requestId: string,
  ) {
    return this.tariffs.toggleDiscount(id, dto.isActive, user, { ...info, requestId });
  }
}
