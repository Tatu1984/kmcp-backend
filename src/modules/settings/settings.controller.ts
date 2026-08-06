import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { z } from "zod";

import { zodPipe } from "@/common/pipes/zod-validation.pipe";
import {
  ClientInfo,
  CurrentUser,
  Public,
  RequestId,
  RequirePermissions,
  type AuthenticatedUser,
} from "@/common/decorators/auth.decorators";
import { SettingsService } from "./settings.service";
import {
  BulkConfigSchema,
  ConfigKeySchema,
  SetConfigSchema,
  UpdateBannerSchema,
  UpsertBannerSchema,
  UpsertFaqSchema,
  UpsertPageSchema,
  type BulkConfigDto,
  type SetConfigDto,
  type UpdateBannerDto,
  type UpsertBannerDto,
  type UpsertFaqDto,
  type UpsertPageDto,
} from "./dto/settings.dto";

const IncludeInactive = z.object({ includeInactive: z.coerce.boolean().optional() });
const AudienceQuery = z.object({ audience: z.enum(["CITIZEN", "VENDOR"]).default("CITIZEN") });

/**
 * System configuration and the content surfaces — pages, FAQs and banners —
 * that the apps render but the authority owns.
 */
@ApiTags("Settings & CMS")
@ApiBearerAuth("bearer")
@Controller()
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @RequirePermissions("config.write")
  @Get("config")
  @ApiOperation({ summary: "All configuration, grouped by namespace" })
  listConfig() {
    return this.settings.listConfig();
  }

  @RequirePermissions("config.write")
  @Put("config/:key")
  @ApiOperation({ summary: "Set one configuration value" })
  setConfig(
    @Param("key", zodPipe(ConfigKeySchema)) key: string,
    @Body(zodPipe(SetConfigSchema)) dto: SetConfigDto,
    @CurrentUser() user: AuthenticatedUser,
    @ClientInfo() info: { ip?: string },
    @RequestId() requestId: string,
  ) {
    return this.settings.setConfig(key, dto, user, { ...info, requestId });
  }

  @RequirePermissions("config.write")
  @Post("config")
  @ApiOperation({ summary: "Save a whole section of settings at once" })
  setConfigBulk(
    @Body(zodPipe(BulkConfigSchema)) dto: BulkConfigDto,
    @CurrentUser() user: AuthenticatedUser,
    @ClientInfo() info: { ip?: string },
    @RequestId() requestId: string,
  ) {
    return this.settings.setConfigBulk(dto, user, { ...info, requestId });
  }

  @Public()
  @Get("public/pages")
  @ApiOperation({
    summary: "Published pages",
    description: "Public — terms, privacy and help are read before anyone signs in.",
  })
  listPublicPages() {
    return this.settings.listPages(false);
  }

  @Public()
  @Get("public/pages/:slug")
  @ApiOperation({ summary: "One published page" })
  getPublicPage(@Param("slug") slug: string) {
    return this.settings.getPage(slug, false);
  }

  @Public()
  @Get("public/faqs")
  @ApiOperation({ summary: "Active FAQs in display order" })
  listPublicFaqs() {
    return this.settings.listFaqs(false);
  }

  @Public()
  @Get("public/banners")
  @ApiOperation({ summary: "Banners live right now for one audience" })
  liveBanners(@Query(zodPipe(AudienceQuery)) query: { audience: "CITIZEN" | "VENDOR" }) {
    return this.settings.liveBanners(query.audience);
  }

  @RequirePermissions("cms.write")
  @Get("cms/pages")
  @ApiOperation({ summary: "Every page, drafts included" })
  listPages() {
    return this.settings.listPages(true);
  }

  @RequirePermissions("cms.write")
  @Get("cms/pages/:slug")
  @ApiOperation({ summary: "One page, draft or published" })
  getPage(@Param("slug") slug: string) {
    return this.settings.getPage(slug, true);
  }

  @RequirePermissions("cms.write")
  @Put("cms/pages")
  @ApiOperation({ summary: "Create or update a page, optionally publishing it" })
  upsertPage(
    @Body(zodPipe(UpsertPageSchema)) dto: UpsertPageDto,
    @CurrentUser() user: AuthenticatedUser,
    @ClientInfo() info: { ip?: string },
    @RequestId() requestId: string,
  ) {
    return this.settings.upsertPage(dto, user, { ...info, requestId });
  }

  @RequirePermissions("cms.write")
  @Delete("cms/pages/:slug")
  @ApiOperation({ summary: "Delete a page" })
  removePage(
    @Param("slug") slug: string,
    @CurrentUser() user: AuthenticatedUser,
    @ClientInfo() info: { ip?: string },
    @RequestId() requestId: string,
  ) {
    return this.settings.removePage(slug, user, { ...info, requestId });
  }

  @RequirePermissions("cms.write")
  @Get("cms/faqs")
  @ApiOperation({ summary: "Every FAQ, inactive included" })
  listFaqs(@Query(zodPipe(IncludeInactive)) query: { includeInactive?: boolean }) {
    return this.settings.listFaqs(query.includeInactive ?? true);
  }

  @RequirePermissions("cms.write")
  @Post("cms/faqs")
  @ApiOperation({ summary: "Add an FAQ" })
  createFaq(
    @Body(zodPipe(UpsertFaqSchema)) dto: UpsertFaqDto,
    @CurrentUser() user: AuthenticatedUser,
    @ClientInfo() info: { ip?: string },
    @RequestId() requestId: string,
  ) {
    return this.settings.createFaq(dto, user, { ...info, requestId });
  }

  @RequirePermissions("cms.write")
  @Patch("cms/faqs/:id")
  @ApiOperation({ summary: "Edit an FAQ" })
  updateFaq(
    @Param("id") id: string,
    @Body(zodPipe(UpsertFaqSchema.partial())) dto: Partial<UpsertFaqDto>,
    @CurrentUser() user: AuthenticatedUser,
    @ClientInfo() info: { ip?: string },
    @RequestId() requestId: string,
  ) {
    return this.settings.updateFaq(id, dto, user, { ...info, requestId });
  }

  @RequirePermissions("cms.write")
  @Delete("cms/faqs/:id")
  @ApiOperation({ summary: "Delete an FAQ" })
  removeFaq(
    @Param("id") id: string,
    @CurrentUser() user: AuthenticatedUser,
    @ClientInfo() info: { ip?: string },
    @RequestId() requestId: string,
  ) {
    return this.settings.removeFaq(id, user, { ...info, requestId });
  }

  @RequirePermissions("cms.write")
  @Get("cms/banners")
  @ApiOperation({ summary: "Every banner, past and future" })
  listBanners() {
    return this.settings.listBanners();
  }

  @RequirePermissions("cms.write")
  @Post("cms/banners")
  @ApiOperation({ summary: "Schedule a banner" })
  createBanner(
    @Body(zodPipe(UpsertBannerSchema)) dto: UpsertBannerDto,
    @CurrentUser() user: AuthenticatedUser,
    @ClientInfo() info: { ip?: string },
    @RequestId() requestId: string,
  ) {
    return this.settings.createBanner(dto, user, { ...info, requestId });
  }

  @RequirePermissions("cms.write")
  @Patch("cms/banners/:id")
  @ApiOperation({ summary: "Edit or retire a banner" })
  updateBanner(
    @Param("id") id: string,
    @Body(zodPipe(UpdateBannerSchema)) dto: UpdateBannerDto,
    @CurrentUser() user: AuthenticatedUser,
    @ClientInfo() info: { ip?: string },
    @RequestId() requestId: string,
  ) {
    return this.settings.updateBanner(id, dto, user, { ...info, requestId });
  }

  @RequirePermissions("cms.write")
  @Delete("cms/banners/:id")
  @ApiOperation({ summary: "Delete a banner" })
  removeBanner(
    @Param("id") id: string,
    @CurrentUser() user: AuthenticatedUser,
    @ClientInfo() info: { ip?: string },
    @RequestId() requestId: string,
  ) {
    return this.settings.removeBanner(id, user, { ...info, requestId });
  }
}
