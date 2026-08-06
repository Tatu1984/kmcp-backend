import { Body, Controller, Get, Param, Patch, Post, Query } from "@nestjs/common";
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
import { VendorsService } from "./vendors.service";
import {
  AddDocumentSchema,
  AssignZonesSchema,
  CommissionSchema,
  CreateVendorSchema,
  UpdateVendorSchema,
  VendorQuerySchema,
  VendorStatusSchema,
  type AddDocumentDto,
  type AssignZonesDto,
  type CommissionDto,
  type CreateVendorDto,
  type UpdateVendorDto,
  type VendorQueryDto,
  type VendorStatusDto,
} from "./dto/vendor.dto";

const VerifySchema = z.object({ verified: z.boolean() });

@ApiTags("Vendors")
@ApiBearerAuth("bearer")
@Controller("vendors")
export class VendorsController {
  constructor(private readonly vendors: VendorsService) {}

  @RequirePermissions("vendor.read")
  @Get("dashboard")
  @ApiOperation({
    summary: "The vendor app home screen in one call",
    description: "Active parking, today's cash and digital collection, and settlement due.",
  })
  dashboard(@CurrentUser() user: AuthenticatedUser) {
    return this.vendors.dashboard(user);
  }

  @RequirePermissions("vendor.read")
  @Get()
  @ApiOperation({ summary: "List vendors with their KYC state" })
  list(@Query(zodPipe(VendorQuerySchema)) query: VendorQueryDto, @CurrentUser() user: AuthenticatedUser) {
    return this.vendors.list(query, user);
  }

  @RequirePermissions("vendor.read")
  @Get(":id")
  @ApiOperation({ summary: "One vendor with documents and assigned zones" })
  findOne(@Param("id") id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.vendors.findOne(id, user);
  }

  @RequirePermissions("vendor.read")
  @Get(":id/performance")
  @ApiOperation({ summary: "Collections, shares and cash-variance count for the month" })
  performance(@Param("id") id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.vendors.performance(id, user);
  }

  @RequirePermissions("vendor.write")
  @Post()
  @ApiOperation({
    summary: "Register a vendor",
    description: "Creates the organisation and its portal login together, in PENDING state.",
  })
  create(
    @Body(zodPipe(CreateVendorSchema)) dto: CreateVendorDto,
    @CurrentUser() user: AuthenticatedUser,
    @ClientInfo() info: { ip?: string },
    @RequestId() requestId: string,
  ) {
    return this.vendors.create(dto, user, { ...info, requestId });
  }

  @RequirePermissions("vendor.write")
  @Patch(":id")
  @ApiOperation({ summary: "Update vendor details" })
  update(
    @Param("id") id: string,
    @Body(zodPipe(UpdateVendorSchema)) dto: UpdateVendorDto,
    @CurrentUser() user: AuthenticatedUser,
    @ClientInfo() info: { ip?: string },
    @RequestId() requestId: string,
  ) {
    return this.vendors.update(id, dto, user, { ...info, requestId });
  }

  @RequirePermissions("vendor.approve")
  @Post(":id/status")
  @ApiOperation({
    summary: "Approve, suspend or block a vendor",
    description:
      "Approval is refused until every required KYC document is verified. Blocking releases the " +
      "vendor's zones, deactivates their attendants and suspends their login.",
  })
  changeStatus(
    @Param("id") id: string,
    @Body(zodPipe(VendorStatusSchema)) dto: VendorStatusDto,
    @CurrentUser() user: AuthenticatedUser,
    @ClientInfo() info: { ip?: string },
    @RequestId() requestId: string,
  ) {
    return this.vendors.changeStatus(id, dto, user, { ...info, requestId });
  }

  @RequirePermissions("vendor.write")
  @Post(":id/documents")
  @ApiOperation({ summary: "Attach a KYC or agreement document" })
  addDocument(
    @Param("id") id: string,
    @Body(zodPipe(AddDocumentSchema)) dto: AddDocumentDto,
    @CurrentUser() user: AuthenticatedUser,
    @ClientInfo() info: { ip?: string },
    @RequestId() requestId: string,
  ) {
    return this.vendors.addDocument(id, dto, user, { ...info, requestId });
  }

  @RequirePermissions("vendor.approve")
  @Patch("documents/:documentId")
  @ApiOperation({ summary: "Verify or reject a document" })
  verifyDocument(
    @Param("documentId") documentId: string,
    @Body(zodPipe(VerifySchema)) dto: { verified: boolean },
    @CurrentUser() user: AuthenticatedUser,
    @ClientInfo() info: { ip?: string },
    @RequestId() requestId: string,
  ) {
    return this.vendors.verifyDocument(documentId, dto.verified, user, { ...info, requestId });
  }

  @RequirePermissions("vendor.write")
  @Post(":id/zones")
  @ApiOperation({
    summary: "Assign kerb to a vendor",
    description: "A zone belongs to one vendor at a time — any other live assignment is ended.",
  })
  assignZones(
    @Param("id") id: string,
    @Body(zodPipe(AssignZonesSchema)) dto: AssignZonesDto,
    @CurrentUser() user: AuthenticatedUser,
    @ClientInfo() info: { ip?: string },
    @RequestId() requestId: string,
  ) {
    return this.vendors.assignZones(id, dto, user, { ...info, requestId });
  }

  @RequirePermissions("vendor.write")
  @Patch(":id/commission")
  @ApiOperation({
    summary: "Change the commission rate",
    description: "Applies from the next settlement cycle; existing settlements keep their rate.",
  })
  setCommission(
    @Param("id") id: string,
    @Body(zodPipe(CommissionSchema)) dto: CommissionDto,
    @CurrentUser() user: AuthenticatedUser,
    @ClientInfo() info: { ip?: string },
    @RequestId() requestId: string,
  ) {
    return this.vendors.setCommission(id, dto, user, { ...info, requestId });
  }
}
