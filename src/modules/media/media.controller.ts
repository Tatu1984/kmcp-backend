import { Body, Controller, Delete, Get, Param, Post, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";

import { zodPipe } from "@/common/pipes/zod-validation.pipe";
import {
  ClientInfo,
  CurrentUser,
  RequestId,
  RequirePermissions,
  type AuthenticatedUser,
} from "@/common/decorators/auth.decorators";
import { Paginated } from "@/common/interceptors/response.interceptor";
import { MediaService } from "./media.service";
import {
  ConfirmUploadSchema,
  MediaQuerySchema,
  RequestUploadSchema,
  SignBatchSchema,
  type ConfirmUploadDto,
  type MediaQueryDto,
  type RequestUploadDto,
  type SignBatchDto,
} from "./dto/media.dto";

/**
 * Two-step upload: ask for a presigned URL, PUT the bytes straight to storage,
 * then confirm. The file never travels through this API.
 *
 * Reads are signed and short-lived — nothing in the bucket is public, because
 * it holds number plates, KYC documents and bank proofs.
 */
@ApiTags("Media")
@ApiBearerAuth("bearer")
@Controller("media")
export class MediaController {
  constructor(private readonly media: MediaService) {}

  // Any authenticated user may upload: attendants photograph plates, vendors
  // supply KYC. What the file may be is constrained by purpose and MIME type.
  @Post("uploads")
  @ApiOperation({
    summary: "Get a presigned URL to upload one file",
    description: "PUT the bytes to `uploadUrl` with the given content-type, then call confirm.",
  })
  requestUpload(
    @Body(zodPipe(RequestUploadSchema)) dto: RequestUploadDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.media.requestUpload(dto, user);
  }

  @Post("uploads/confirm")
  @ApiOperation({
    summary: "Record a completed upload",
    description: "Returns the existing record if called twice, so a retry is safe.",
  })
  confirmUpload(
    @Body(zodPipe(ConfirmUploadSchema)) dto: ConfirmUploadDto,
    @CurrentUser() user: AuthenticatedUser,
    @ClientInfo() info: { ip?: string },
    @RequestId() requestId: string,
  ) {
    return this.media.confirmUpload(dto, user, { ...info, requestId });
  }

  @Get(":id/url")
  @ApiOperation({ summary: "A short-lived read URL for one file" })
  signedUrl(@Param("id") id: string) {
    return this.media.signedUrl(id);
  }

  @Post("urls")
  @ApiOperation({
    summary: "Read URLs for several files at once",
    description: "A document panel needs six at a time; this saves six round trips.",
  })
  signedUrls(@Body(zodPipe(SignBatchSchema)) dto: SignBatchDto) {
    return this.media.signedUrls(dto.ids);
  }

  @RequirePermissions("audit.read")
  @Get()
  @ApiOperation({ summary: "Everything uploaded, newest first" })
  async list(@Query(zodPipe(MediaQuerySchema)) query: MediaQueryDto) {
    const { items, total } = await this.media.list(query);
    return new Paginated(items, query.page, query.pageSize, total);
  }

  @RequirePermissions("config.write")
  @Delete(":id")
  @ApiOperation({
    summary: "Delete a file",
    description: "Refused for parking evidence and for anything still attached to a vendor document.",
  })
  remove(
    @Param("id") id: string,
    @CurrentUser() user: AuthenticatedUser,
    @ClientInfo() info: { ip?: string },
    @RequestId() requestId: string,
  ) {
    return this.media.remove(id, user, { ...info, requestId });
  }
}
