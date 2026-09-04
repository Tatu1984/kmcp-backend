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

  // No @RequirePermissions here, because no single grant describes who may read
  // a file: it depends on whose file it is. The check is per media id, inside
  // MediaAccessService, and it needs the caller — which is why both of these
  // take @CurrentUser rather than an id alone.
  @Get(":id/url")
  @ApiOperation({
    summary: "A short-lived read URL for one file",
    description:
      "Issued only to the people the file is about — the citizen whose vehicle it is, the vendor " +
      "whose document it is, the attendant who recorded it — and to staff whose role covers it.",
  })
  signedUrl(@Param("id") id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.media.signedUrl(id, user);
  }

  @Post("urls")
  @ApiOperation({
    summary: "Read URLs for several files at once",
    description:
      "A document panel needs six at a time; this saves six round trips. Every id is authorised " +
      "the same way as the single-item route, and one refusal fails the whole batch.",
  })
  signedUrls(
    @Body(zodPipe(SignBatchSchema)) dto: SignBatchDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.media.signedUrls(dto.ids, user);
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
