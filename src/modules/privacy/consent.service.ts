import { Injectable, Logger } from "@nestjs/common";
import { ConsentAction, ConsentPurpose, LocationConsentStatus } from "@prisma/client";

import { PrismaService } from "@/prisma/prisma.service";
import { AppException } from "@/common/errors/app.exception";
import { SYSTEM_ROLES } from "@/common/rbac/permissions";
import type { AuthenticatedUser } from "@/common/decorators/auth.decorators";
import type { RecordConsentDto } from "./dto/privacy.dto";

/**
 * The CMS slug of the privacy notice.
 *
 * Consent under section 6 of the DPDP Act is consent *to the notice served with
 * it*. Recording that somebody agreed without recording what they were shown
 * proves nothing — so every consent record stamps this slug and the timestamp
 * the page carried at that moment, which together identify a version of the
 * text the CMS can still produce.
 */
export const PRIVACY_NOTICE_SLUG = "kmcp-privacy";

export interface ConsentContext {
  channel: string;
  ip?: string;
  userAgent?: string;
  requestId?: string;
  /** Set only when an officer recorded the decision on somebody's behalf. */
  recordedById?: string;
}

/**
 * Consent, made demonstrable.
 *
 * What was already here was `LocationConsent`: one row per user, upserted on
 * every change, holding the current answer and the latest fix. It does its job
 * — the app needs to know whether it may ask for a position right now — and it
 * is not evidence of anything. Four things were missing, and each of them is
 * something the authority would be asked for:
 *
 *  - **History.** An upsert overwrites. After a withdrawal there was nothing
 *    left to show consent had ever been given, when, or for how long — so the
 *    authority could not answer "we processed this lawfully between March and
 *    September" even when it was true.
 *  - **Purpose.** Consent is always consent *to a specified purpose*. The old
 *    model named its purpose in the model name, so it could hold exactly one,
 *    and the other things this platform does on consent — photographing a
 *    vehicle at the kerb, messaging a citizen, announcing to them — had no
 *    record at all.
 *  - **The notice.** Section 5 requires notice; section 6 makes the fiduciary
 *    prove consent. Neither is provable without knowing which text was on the
 *    screen, and nothing recorded that.
 *  - **Evidence of the act.** No IP, no user agent, no request id, and no way
 *    to tell a person's own tap from an officer ticking a box for them — which
 *    are very different records if either is ever challenged.
 *
 * `ConsentRecord` fixes all four and nothing in this codebase updates or
 * deletes a row of it. `LocationConsent` is left exactly as it was, still the
 * current-state answer, and now written alongside a ledger entry.
 */
@Injectable()
export class ConsentService {
  private readonly logger = new Logger(ConsentService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Appends one decision to the ledger.
   *
   * Never throws into the caller's path. A consent *record* that failed to
   * write must not fail the consent itself — refusing to accept somebody's
   * withdrawal because the audit copy did not save would be the worst possible
   * reading of a privacy control. The failure is logged loudly instead, which
   * is the same trade `AuditService` makes and for the same reason.
   */
  async record(
    userId: string,
    purpose: ConsentPurpose,
    action: ConsentAction,
    context: ConsentContext,
  ): Promise<void> {
    try {
      const notice = await this.currentNotice();
      await this.prisma.consentRecord.create({
        data: {
          userId,
          purpose,
          action,
          noticeSlug: notice?.slug ?? null,
          noticeVersion: notice?.updatedAt ?? null,
          channel: context.channel,
          ip: context.ip ?? null,
          userAgent: context.userAgent ?? null,
          requestId: context.requestId ?? null,
          recordedById: context.recordedById ?? null,
        },
      });
    } catch (error) {
      this.logger.error(
        `Failed to record ${action} consent for ${purpose} — the decision itself stands.`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  /** The privacy notice as it stands, or null if the authority has not written one. */
  private async currentNotice() {
    return this.prisma.cmsPage.findUnique({
      where: { slug: PRIVACY_NOTICE_SLUG },
      select: { slug: true, updatedAt: true, publishedAt: true },
    });
  }

  /**
   * A person recording their own decision.
   *
   * Self-service, so `recordedById` is left unset — which is what makes this a
   * stronger record than an officer's entry, and the distinction is visible in
   * the ledger rather than inferred.
   *
   * `PRECISE_LOCATION` also writes through to `LocationConsent`, because that
   * row is what the rest of the platform actually reads before capturing a fix.
   * A ledger the enforcement path does not consult would be a compliance
   * theatre with real consequences: the record would say withdrawn and the
   * handset would carry on collecting.
   */
  async submit(user: AuthenticatedUser, dto: RecordConsentDto, context: ConsentContext) {
    const action = dto.granted ? ConsentAction.GRANTED : ConsentAction.WITHDRAWN;

    if (dto.purpose === ConsentPurpose.PRECISE_LOCATION) {
      await this.prisma.locationConsent.upsert({
        where: { userId: user.id },
        create: {
          userId: user.id,
          userName: user.name,
          userRole: user.role,
          status: dto.granted ? LocationConsentStatus.GRANTED : LocationConsentStatus.DENIED,
          respondedAt: new Date(),
          userAgent: context.userAgent,
        },
        update: {
          status: dto.granted ? LocationConsentStatus.GRANTED : LocationConsentStatus.DENIED,
          respondedAt: new Date(),
          // Withdrawal erases the stored fix rather than merely stopping new
          // ones, mirroring what ActivityService.setConsent already does.
          ...(dto.granted
            ? {}
            : { latitude: null, longitude: null, accuracyM: null, capturedAt: null }),
          userAgent: context.userAgent,
        },
      });
    }

    await this.record(user.id, dto.purpose, action, context);
    return this.history(user.id);
  }

  /**
   * Everything recorded about one person's consent — the current position per
   * purpose, and the decisions that produced it.
   *
   * This is the answer to a regulator's question, so it is shaped like the
   * question: for each purpose, are we processing on consent right now, since
   * when, and against which version of the notice.
   */
  async history(userId: string) {
    const [user, records, current] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, name: true, role: true, status: true },
      }),
      this.prisma.consentRecord.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        take: 500,
      }),
      this.prisma.locationConsent.findUnique({ where: { userId } }),
    ]);
    if (!user) throw AppException.notFound("user");

    // The latest decision per purpose. The list is already newest-first, so the
    // first sighting of a purpose is its current position.
    const latest = new Map<ConsentPurpose, (typeof records)[number]>();
    for (const record of records) {
      if (!latest.has(record.purpose)) latest.set(record.purpose, record);
    }

    const purposes = Object.values(ConsentPurpose).map((purpose) => {
      const decision = latest.get(purpose);
      return {
        purpose,
        status: decision?.action ?? null,
        // Null means never asked, which is a different thing from refused and
        // has to read differently on the screen.
        decidedAt: decision?.createdAt ?? null,
        noticeSlug: decision?.noticeSlug ?? null,
        noticeVersion: decision?.noticeVersion ?? null,
        channel: decision?.channel ?? null,
        recordedByOfficer: Boolean(decision?.recordedById),
        decisions: records.filter((r) => r.purpose === purpose).length,
      };
    });

    return {
      user,
      purposes,
      /** The live flag the platform reads before capturing a precise position. */
      locationConsent: current,
      history: records,
      truncated: records.length === 500,
    };
  }

  /**
   * How consent looks across the whole register, for the settings screen.
   *
   * Deliberately counts and not people: an officer looking at the data-rights
   * panel needs to know whether consent is being captured at all, not who
   * refused.
   */
  async summary() {
    const [byPurpose, citizens, notice] = await Promise.all([
      this.prisma.consentRecord.groupBy({
        by: ["purpose", "action"],
        _count: { _all: true },
      }),
      this.prisma.user.count({ where: { role: SYSTEM_ROLES.CITIZEN, deletedAt: null } }),
      this.currentNotice(),
    ]);

    const purposes = Object.values(ConsentPurpose).map((purpose) => {
      const rows = byPurpose.filter((r) => r.purpose === purpose);
      const count = (action: ConsentAction) =>
        rows.find((r) => r.action === action)?._count._all ?? 0;
      return {
        purpose,
        granted: count(ConsentAction.GRANTED),
        withdrawn: count(ConsentAction.WITHDRAWN),
        denied: count(ConsentAction.DENIED),
      };
    });

    return {
      citizens,
      purposes,
      notice: notice
        ? {
            slug: notice.slug,
            updatedAt: notice.updatedAt,
            published: Boolean(notice.publishedAt),
          }
        : null,
      // Said out loud because it is the one thing that makes every record below
      // worthless: a notice nobody can read is not notice.
      warning: notice
        ? notice.publishedAt
          ? null
          : `The privacy notice at "${PRIVACY_NOTICE_SLUG}" is a draft. Consent is being recorded against a notice no citizen can read.`
        : `There is no privacy notice at "${PRIVACY_NOTICE_SLUG}". Consent recorded now names no notice at all.`,
    };
  }
}
