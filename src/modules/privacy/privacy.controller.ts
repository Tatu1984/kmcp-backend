import { Body, Controller, Get, Param, Patch, Post } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";

import { zodPipe } from "@/common/pipes/zod-validation.pipe";
import { AppException } from "@/common/errors/app.exception";
import {
  ClientInfo,
  CurrentUser,
  RequestId,
  RequirePermissions,
  type AuthenticatedUser,
} from "@/common/decorators/auth.decorators";
import { RetentionService } from "./retention.service";
import { SubjectRightsService } from "./subject-rights.service";
import { ConsentService } from "./consent.service";
import {
  CorrectCitizenSchema,
  EraseCitizenSchema,
  RecordConsentSchema,
  type CorrectCitizenDto,
  type EraseCitizenDto,
  type RecordConsentDto,
} from "./dto/privacy.dto";

/**
 * The data-protection surface: what is kept and for how long, and the three
 * rights the DPDP Act gives the person the data is about.
 *
 * Two grants cover everything here, and both are existing ones rather than a
 * new `privacy.*` key. That is deliberate.
 *
 * `config.write` guards the retention policy, because a retention period *is*
 * configuration — it is set in `SystemConfig` and read by the sweep, exactly
 * like the geo-fence tolerance, and it is guarded by the same grant that guards
 * every other row in that table. Someone who can change how long evidence is
 * kept can already change how much a citizen is charged.
 *
 * `user.manage` guards the subject rights, because exporting, correcting or
 * erasing somebody's account is account administration. It is the same grant
 * that already lets an officer blacklist a citizen and end their sessions, and
 * `citizens.controller.ts` reaches the same conclusion for the same reason.
 *
 * A new permission would have been the tidier catalogue and the worse system:
 * grants are rows in the `Role` table now, so a `privacy.export` key would be
 * held by nobody on the day it shipped — including the SUPER_ADMIN's own
 * matrix — and the compliance route we have contracted to deliver would answer
 * 403 to every officer until someone found the checkbox. The permissions that
 * exist already say the right thing.
 *
 * Every route that touches one person's data writes an audit row naming the
 * officer who called it. See the services.
 */
@ApiTags("Data protection")
@ApiBearerAuth("bearer")
@Controller("privacy")
export class PrivacyController {
  constructor(
    private readonly retention: RetentionService,
    private readonly rights: SubjectRightsService,
    private readonly consent: ConsentService,
  ) {}

  // ------------------------------------------------------------- retention

  @RequirePermissions("config.write")
  @Get("retention")
  @ApiOperation({
    summary: "The retention schedule as it is actually running",
    description:
      "Every period, the configuration key that holds it, whether the authority has set it or " +
      "is still on the seeded default, and whether the purge is in report-only mode.",
  })
  policy() {
    return this.retention.policy();
  }

  /**
   * A purge that cannot delete, whatever the configuration says.
   *
   * The officer about to turn `retention.dryRun` off wants to know what happens
   * when they do, and finding out by turning it off is not an experiment with
   * an undo. `now` is omitted so it reads the real clock, and the suspended
   * flag is forced rather than read.
   */
  @RequirePermissions("config.write")
  @Post("retention/preview")
  @ApiOperation({
    summary: "Count what the next purge would destroy, without destroying it",
    description: "Report-only regardless of configuration. Nothing is deleted by this route.",
  })
  preview(@RequestId() requestId: string) {
    return this.retention.preview(requestId);
  }

  // ---------------------------------------------------------- subject rights

  @RequirePermissions("user.manage")
  @Get("citizens/:id/export")
  @ApiOperation({
    summary: "Everything held about one citizen, as JSON",
    description:
      "Profile, vehicles, sessions, payments, receipts, passes, feedback, incidents they raised, " +
      "notification deliveries, consent history and the media ids of evidence featuring their " +
      "vehicles. Audited against the requesting officer.",
  })
  export(
    @Param("id") id: string,
    @CurrentUser() user: AuthenticatedUser,
    @ClientInfo() info: { ip?: string; userAgent?: string },
    @RequestId() requestId: string,
  ) {
    return this.rights.export(id, user, { ...info, requestId });
  }

  @RequirePermissions("user.manage")
  @Post("citizens/:id/erase")
  @ApiOperation({
    summary: "Erase a citizen's personal identifiers, preserving the financial record",
    description:
      "Anonymisation, not deletion. Sessions, payments, receipts and ledger entries are kept and " +
      "continue to refer to an account that identifies nobody — they are tax and accounting " +
      "records the authority is obliged to hold. Refused while anything is still in flight.",
  })
  erase(
    @Param("id") id: string,
    @Body(zodPipe(EraseCitizenSchema)) dto: EraseCitizenDto,
    @CurrentUser() user: AuthenticatedUser,
    @ClientInfo() info: { ip?: string; userAgent?: string },
    @RequestId() requestId: string,
  ) {
    // Checked here rather than in the schema, which cannot see the path.
    // Retyping the id is what separates "erase this citizen" from "erase
    // whichever row was under the cursor".
    if (dto.confirmCitizenId !== id) {
      throw new AppException(
        "VALIDATION_FAILED",
        [{ field: "confirmCitizenId", issue: "does not match the citizen being erased" }],
        "Confirm the erasure by repeating the citizen's id exactly.",
      );
    }
    return this.rights.erase(id, dto, user, { ...info, requestId });
  }

  @RequirePermissions("user.manage")
  @Patch("citizens/:id")
  @ApiOperation({
    summary: "Correct inaccurate personal data",
    description: "Name, mobile number and email address. Before and after both reach the audit trail.",
  })
  correct(
    @Param("id") id: string,
    @Body(zodPipe(CorrectCitizenSchema)) dto: CorrectCitizenDto,
    @CurrentUser() user: AuthenticatedUser,
    @ClientInfo() info: { ip?: string; userAgent?: string },
    @RequestId() requestId: string,
  ) {
    return this.rights.correct(id, dto, user, { ...info, requestId });
  }

  // ---------------------------------------------------------------- consent

  @RequirePermissions("user.manage")
  @Get("citizens/:id/consents")
  @ApiOperation({
    summary: "One person's consent record — what was given, when, and against which notice",
    description: "The answer to a regulator asking the authority to demonstrate consent.",
  })
  consents(@Param("id") id: string) {
    return this.consent.history(id);
  }

  @RequirePermissions("config.write")
  @Get("consents/summary")
  @ApiOperation({ summary: "Consent across the whole register, and the state of the notice" })
  consentSummary() {
    return this.consent.summary();
  }

  /**
   * The signed-in person's own record. No permission decorator, because the
   * row set is the authorisation — every method below is written in terms of
   * the caller's own id and there is no parameter that could name anyone else.
   */
  @Get("consents/me")
  @ApiOperation({ summary: "Your own consent record" })
  ownConsents(@CurrentUser() user: AuthenticatedUser) {
    return this.consent.history(user.id);
  }

  @Post("consents")
  @ApiOperation({
    summary: "Give or withdraw your own consent for one purpose",
    description:
      "Appended to the consent ledger, stamped with the version of the privacy notice in force. " +
      "Withdrawing precise-location consent also erases the stored fix.",
  })
  giveConsent(
    @Body(zodPipe(RecordConsentSchema)) dto: RecordConsentDto,
    @CurrentUser() user: AuthenticatedUser,
    @ClientInfo() info: { ip?: string; userAgent?: string },
    @RequestId() requestId: string,
  ) {
    return this.consent.submit(user, dto, { channel: "PORTAL", ...info, requestId });
  }
}
