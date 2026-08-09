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
import { IncidentsService } from "./incidents.service";
import {
  AssignIncidentSchema,
  CreateIncidentSchema,
  IncidentQuerySchema,
  RejectIncidentSchema,
  ResolveIncidentSchema,
  type AssignIncidentDto,
  type CreateIncidentDto,
  type IncidentQueryDto,
  type RejectIncidentDto,
  type ResolveIncidentDto,
} from "./dto/incident.dto";

@ApiTags("Incidents")
@ApiBearerAuth("bearer")
@Controller("incidents")
export class IncidentsController {
  constructor(private readonly incidents: IncidentsService) {}

  @RequirePermissions("session.read")
  @Get()
  @ApiOperation({ summary: "Incidents, filtered by status, type, zone, session or assignee" })
  list(@Query(zodPipe(IncidentQuerySchema)) query: IncidentQueryDto, @CurrentUser() user: AuthenticatedUser) {
    return this.incidents.list(query, user);
  }

  @RequirePermissions("session.read")
  @Get("summary")
  @ApiOperation({ summary: "Counts by status and by type" })
  summary(@CurrentUser() user: AuthenticatedUser) {
    return this.incidents.summary(user);
  }

  @RequirePermissions("session.read")
  @Get(":id")
  @ApiOperation({ summary: "One incident" })
  findOne(@Param("id") id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.incidents.findOne(id, user);
  }

  // Raising one sits on session.read, not incident.manage: an attendant at the
  // kerb reports what they see, and they are not an incident manager.
  @RequirePermissions("session.read")
  @Post()
  @ApiOperation({
    summary: "Raise an incident",
    description: "Needs a session or a zone. When only a session is given the zone is taken from it.",
  })
  create(
    @Body(zodPipe(CreateIncidentSchema)) dto: CreateIncidentDto,
    @CurrentUser() user: AuthenticatedUser,
    @ClientInfo() info: { ip?: string },
    @RequestId() requestId: string,
  ) {
    return this.incidents.create(dto, user, { ...info, requestId });
  }

  @RequirePermissions("incident.manage")
  @Post(":id/assign")
  @ApiOperation({ summary: "Assign to someone", description: "Moves an open incident to in progress." })
  assign(
    @Param("id") id: string,
    @Body(zodPipe(AssignIncidentSchema)) dto: AssignIncidentDto,
    @CurrentUser() user: AuthenticatedUser,
    @ClientInfo() info: { ip?: string },
    @RequestId() requestId: string,
  ) {
    return this.incidents.assign(id, dto, user, { ...info, requestId });
  }

  @RequirePermissions("incident.manage")
  @Post(":id/start")
  @ApiOperation({
    summary: "Pick it up",
    description: "Moves it to in progress, assigning it to the caller if nobody holds it yet.",
  })
  start(
    @Param("id") id: string,
    @CurrentUser() user: AuthenticatedUser,
    @ClientInfo() info: { ip?: string },
    @RequestId() requestId: string,
  ) {
    return this.incidents.start(id, user, { ...info, requestId });
  }

  @RequirePermissions("incident.manage")
  @Post(":id/resolve")
  @ApiOperation({
    summary: "Resolve",
    description: "The note is required — it is what a complaint gets answered from later.",
  })
  resolve(
    @Param("id") id: string,
    @Body(zodPipe(ResolveIncidentSchema)) dto: ResolveIncidentDto,
    @CurrentUser() user: AuthenticatedUser,
    @ClientInfo() info: { ip?: string },
    @RequestId() requestId: string,
  ) {
    return this.incidents.resolve(id, dto, user, { ...info, requestId });
  }

  @RequirePermissions("incident.manage")
  @Post(":id/reject")
  @ApiOperation({ summary: "Reject with a reason", description: "The report stays on the record." })
  reject(
    @Param("id") id: string,
    @Body(zodPipe(RejectIncidentSchema)) dto: RejectIncidentDto,
    @CurrentUser() user: AuthenticatedUser,
    @ClientInfo() info: { ip?: string },
    @RequestId() requestId: string,
  ) {
    return this.incidents.reject(id, dto, user, { ...info, requestId });
  }
}
