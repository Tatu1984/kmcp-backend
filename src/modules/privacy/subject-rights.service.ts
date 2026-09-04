import { Injectable, Logger } from "@nestjs/common";
import { IncidentStatus, PassStatus, PaymentStatus, Prisma, SessionStatus, UserStatus } from "@prisma/client";

import { PrismaService } from "@/prisma/prisma.service";
import { AppException } from "@/common/errors/app.exception";
import { AuditService } from "@/common/services/audit.service";
import { SYSTEM_ROLES } from "@/common/rbac/permissions";
import type { AuthenticatedUser } from "@/common/decorators/auth.decorators";
import { RetentionService } from "./retention.service";
import type { CorrectCitizenDto, EraseCitizenDto } from "./dto/privacy.dto";

type Ctx = { ip?: string; userAgent?: string; requestId?: string };

/**
 * No single collection in an export may exceed this.
 *
 * A citizen with four years of daily commuter parking has well over a thousand
 * sessions, and the whole package is assembled in one serverless invocation and
 * returned in one response. The cap is generous enough that almost every real
 * export is complete, and each section says whether it was truncated — a
 * silently short export is a worse answer to a subject-access request than an
 * honest partial one.
 */
const MAX_ROWS = 1000;

/** Statuses that mean money or a dispute is still in flight. */
const IN_FLIGHT: SessionStatus[] = [
  SessionStatus.ACTIVE,
  SessionStatus.OVERSTAY,
  SessionStatus.DISPUTED,
];

const OPEN_INCIDENT: IncidentStatus[] = [IncidentStatus.OPEN, IncidentStatus.IN_PROGRESS];

/** The name an erased account carries. Not a person's name, and not blank. */
const ERASED_NAME = "Erased citizen";

/**
 * The three rights the DPDP Act gives the person whose data this is: to see it,
 * to correct it, and to have it erased.
 *
 * Everything here goes through `vehicle.ownerUserId`, for the reason
 * `CitizensService` explains at length: a parking session belongs to a *plate*,
 * and a plate belongs to a person only once they claim it in the app. There is
 * no owner column on a session to filter by.
 */
@Injectable()
export class SubjectRightsService {
  private readonly logger = new Logger(SubjectRightsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly retention: RetentionService,
  ) {}

  // ----------------------------------------------------------------- access

  /**
   * Everything the platform holds about one citizen, as JSON.
   *
   * Machine-readable by design and not a PDF: the right of access is a right to
   * the data, and a person who wants to take their parking history to a
   * spreadsheet or to another service should not have to retype it out of a
   * rendered document.
   *
   * Evidence photographs appear as media ids rather than as bytes or signed
   * links. A signed URL is a bearer credential that outlives the response and
   * would sit in whatever inbox this package was forwarded to; the ids let the
   * citizen ask for each file individually through the media route, where
   * `MediaAccessService` decides — as it does for every other read — whether
   * they may have it.
   */
  async export(citizenId: string, officer: AuthenticatedUser, ctx: Ctx) {
    const subject = await this.subject(citizenId);

    const vehicles = await this.prisma.vehicle.findMany({
      where: { ownerUserId: citizenId },
      select: {
        id: true,
        plateNumber: true,
        makeModel: true,
        colour: true,
        isBlacklisted: true,
        createdAt: true,
        vehicleType: { select: { code: true, label: true } },
      },
      orderBy: { createdAt: "asc" },
    });
    const vehicleIds = vehicles.map((v) => v.id);

    const sessions = vehicleIds.length
      ? await this.prisma.parkingSession.findMany({
          where: { vehicleId: { in: vehicleIds } },
          select: {
            id: true,
            code: true,
            plateNumber: true,
            status: true,
            source: true,
            startAt: true,
            endAt: true,
            durationMinutes: true,
            startLat: true,
            startLng: true,
            endLat: true,
            endLng: true,
            evidenceStartMediaId: true,
            evidenceEndMediaId: true,
            grossAmount: true,
            discountAmount: true,
            taxAmount: true,
            penaltyAmount: true,
            payableAmount: true,
            fareBreakdown: true,
            cancelledReason: true,
            createdAt: true,
            zone: { select: { code: true, name: true } },
          },
          orderBy: { startAt: "desc" },
          take: MAX_ROWS,
        })
      : [];

    const sessionIds = sessions.map((s) => s.id);

    const [payments, passes, feedback, incidents, notifications, devices, favourites] =
      await Promise.all([
        this.prisma.payment.findMany({
          where: {
            OR: [
              { paidByUserId: citizenId },
              ...(sessionIds.length ? [{ sessionId: { in: sessionIds } }] : []),
            ],
          },
          select: {
            id: true,
            sessionId: true,
            passId: true,
            mode: true,
            amount: true,
            status: true,
            gateway: true,
            gatewayPaymentId: true,
            paidAt: true,
            refundedAmount: true,
            createdAt: true,
            receipt: {
              select: {
                number: true,
                gstInvoiceNo: true,
                pdfMediaId: true,
                issuedAt: true,
                sentChannels: true,
              },
            },
          },
          orderBy: { createdAt: "desc" },
          take: MAX_ROWS,
        }),
        this.prisma.pass.findMany({
          where: { userId: citizenId },
          select: {
            id: true,
            qrCode: true,
            validFrom: true,
            validTo: true,
            status: true,
            createdAt: true,
            plan: { select: { name: true, price: true, durationDays: true } },
            vehicle: { select: { plateNumber: true } },
          },
          orderBy: { validTo: "desc" },
          take: MAX_ROWS,
        }),
        this.prisma.feedback.findMany({
          where: { userId: citizenId },
          select: { id: true, sessionId: true, rating: true, comment: true, mediaIds: true, createdAt: true },
          orderBy: { createdAt: "desc" },
          take: MAX_ROWS,
        }),
        this.prisma.incident.findMany({
          where: { reportedById: citizenId },
          select: {
            id: true,
            sessionId: true,
            zoneId: true,
            type: true,
            description: true,
            mediaIds: true,
            status: true,
            resolutionNote: true,
            resolvedAt: true,
            createdAt: true,
          },
          orderBy: { createdAt: "desc" },
          take: MAX_ROWS,
        }),
        // The delivery log: what was sent to them, over which channel, and
        // whether it arrived. Part of their data, and the record that answers
        // "why did I get this message".
        this.prisma.notification.findMany({
          where: { userId: citizenId },
          select: {
            id: true,
            channel: true,
            template: true,
            status: true,
            sentAt: true,
            readAt: true,
            createdAt: true,
          },
          orderBy: { createdAt: "desc" },
          take: MAX_ROWS,
        }),
        this.prisma.device.findMany({
          where: { userId: citizenId },
          select: {
            id: true,
            platform: true,
            appVersion: true,
            lastSeenAt: true,
            isActive: true,
            createdAt: true,
          },
        }),
        this.prisma.favourite.findMany({
          where: { userId: citizenId },
          select: { label: true, zone: { select: { code: true, name: true } } },
        }),
      ]);

    const [locationConsent, consentLedger] = await Promise.all([
      this.prisma.locationConsent.findUnique({ where: { userId: citizenId } }),
      this.prisma.consentRecord.findMany({
        where: { userId: citizenId },
        orderBy: { createdAt: "desc" },
        take: MAX_ROWS,
      }),
    ]);

    const evidenceMediaIds = sessions
      .flatMap((s) => [s.evidenceStartMediaId, s.evidenceEndMediaId])
      .filter((id): id is string => Boolean(id));

    // Recorded before the package is handed over, not after. If the write
    // failed the export would still have happened, and an unaudited disclosure
    // of somebody's whole parking history is the thing this trail exists for.
    await this.audit.record({
      actor: officer,
      action: "DATA_SUBJECT_EXPORT",
      entity: "User",
      entityId: citizenId,
      after: {
        sessions: sessions.length,
        payments: payments.length,
        passes: passes.length,
        incidents: incidents.length,
        evidenceFiles: evidenceMediaIds.length,
        reason: null,
      },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      requestId: ctx.requestId,
    });

    return {
      meta: {
        generatedAt: new Date().toISOString(),
        // Who asked, on the record and inside the package itself, so the copy
        // the citizen receives says who produced it.
        generatedBy: { id: officer.id, name: officer.name, role: officer.role },
        subjectId: citizenId,
        format: "application/json",
        rowLimitPerSection: MAX_ROWS,
        truncated: {
          sessions: sessions.length === MAX_ROWS,
          payments: payments.length === MAX_ROWS,
          incidents: incidents.length === MAX_ROWS,
          notifications: notifications.length === MAX_ROWS,
        },
        note:
          "Evidence photographs are listed by media id. Each can be requested individually " +
          "through the media endpoint, which authorises the read at the time it is asked for.",
      },
      profile: subject,
      vehicles,
      sessions,
      payments,
      passes,
      feedback,
      incidentsRaised: incidents,
      notifications,
      devices,
      favouriteZones: favourites,
      consent: { current: locationConsent, history: consentLedger },
      evidenceMediaIds,
    };
  }

  // ---------------------------------------------------------------- erasure

  /**
   * Erasure, done the way the Act actually requires rather than the way the
   * word suggests.
   *
   * A citizen's right to erasure is not a right to delete the authority's
   * books. Section 12(3) of the DPDP Act carves out personal data the
   * fiduciary must keep to comply with any other law in force, and there is a
   * great deal of that here: a parking fare carries GST, its receipt is a tax
   * document, and by the time anyone asks for erasure that payment has been
   * aggregated into a settlement, approved, paid to a vendor and posted to the
   * ledger. Deleting the session would leave a settlement whose lines do not
   * add up and a ledger entry referring to a transaction that no longer exists.
   * The authority would have destroyed its own accounts to honour a request it
   * could have honoured properly.
   *
   * So the financial record is preserved and the *identity* is destroyed. What
   * remains after this runs is a set of parking sessions, payments, receipts
   * and ledger entries which are complete, auditable, and attached to an
   * account that names nobody: no name, no mobile number, no email address, no
   * credentials, no device, no photograph. The rows that pointed at the person
   * still point at that account, which is what keeps the books intact — but the
   * thing they point at is no longer personal data.
   *
   * Three consequences worth being explicit about, because each is a judgement
   * someone may want to revisit:
   *
   *  1. **Vehicles are unclaimed, not deleted.** A registration plate identifies
   *     a *vehicle*, and that vehicle may be parked by somebody else tomorrow;
   *     rewriting the plate would corrupt the operational record and the
   *     vendor's settlement. Severing `ownerUserId` is what matters: after it,
   *     nothing in this platform connects the plate to the person. The plate
   *     remains resolvable to a person by the RTO, which the authority cannot
   *     query and does not hold.
   *
   *  2. **Their evidence photographs are destroyed now** rather than left to
   *     expire, because a photograph of an identifiable vehicle at an
   *     identifiable kerb is the most personal thing here and the financial
   *     record does not depend on it — the fare is proved by the session and
   *     the receipt. Anything an open dispute or incident still needs is held
   *     back, by exactly the same rules the retention sweep uses.
   *
   *  3. **Sign-in records keep their network and device columns** with the name
   *     and the identifier tried removed. They are now attached to an account
   *     that identifies nobody, and they are what an intrusion investigation is
   *     made of. The precise GPS fixes on them are destroyed outright.
   *
   * Erasure is refused outright while anything is still in flight — a live
   * session, an unresolved dispute, an open complaint, an uncaptured payment,
   * a pass still valid. You cannot anonymise a party to a transaction that has
   * not finished, and pretending otherwise would strand the transaction.
   */
  async erase(citizenId: string, dto: EraseCitizenDto, officer: AuthenticatedUser, ctx: Ctx) {
    const subject = await this.subject(citizenId);

    const vehicles = await this.prisma.vehicle.findMany({
      where: { ownerUserId: citizenId },
      select: { id: true },
    });
    const vehicleIds = vehicles.map((v) => v.id);

    const blockers = await this.erasureBlockers(citizenId, vehicleIds);
    if (blockers.length > 0) {
      throw new AppException(
        "VALIDATION_FAILED",
        blockers,
        "This account cannot be erased yet — something it is party to is still open. " +
          "Settle or close the items listed and try again.",
      );
    }

    const sessions = vehicleIds.length
      ? await this.prisma.parkingSession.findMany({
          where: { vehicleId: { in: vehicleIds } },
          select: { evidenceStartMediaId: true, evidenceEndMediaId: true },
        })
      : [];

    const evidenceIds = sessions
      .flatMap((s) => [s.evidenceStartMediaId, s.evidenceEndMediaId])
      .filter((id): id is string => Boolean(id));

    const evidence = await this.retention.destroyEvidence(evidenceIds);

    const now = new Date();

    // One transaction. A half-erased account — name gone, mobile number still
    // there — is neither a working account nor an erased one, and there would
    // be no way to tell from the outside which half had failed.
    const redactions = await this.prisma.$transaction(async (tx) => {
      const [notifications, feedback, authEvents] = await Promise.all([
        // The delivery log keeps its shape — channel, template, status, when —
        // and loses its content. The payload is where the mobile number, the
        // plate and the amount actually sat.
        tx.notification.updateMany({
          where: { userId: citizenId },
          data: { payload: { redacted: true, redactedAt: now.toISOString() } as Prisma.InputJsonValue },
        }),
        // Their own words, about their own parking. The rating is a statistic
        // about a vendor and survives; the comment is theirs and does not.
        tx.feedback.updateMany({
          where: { userId: citizenId, comment: { not: null } },
          data: { comment: null },
        }),
        tx.authEvent.updateMany({
          where: { userId: citizenId },
          data: {
            userName: null,
            identifierTried: null,
            gpsLatitude: null,
            gpsLongitude: null,
            gpsAccuracyM: null,
          },
        }),
      ]);

      const [devices, favourites, loginSessions, trusted] = await Promise.all([
        // Push tokens and fingerprints are live identifiers for a handset that
        // is still in someone's pocket.
        tx.device.deleteMany({ where: { userId: citizenId } }),
        // Which zone somebody labelled "Home" is about as personal as this
        // platform gets, and it has no operational or financial value at all.
        tx.favourite.deleteMany({ where: { userId: citizenId } }),
        // An erased account must not stay signed in anywhere.
        tx.loginSession.deleteMany({ where: { userId: citizenId } }),
        tx.trustedLoginLocation.deleteMany({ where: { userId: citizenId } }),
      ]);

      // The stored fix, not the consent decision. The ledger of decisions is
      // itself a compliance record: the authority may still have to show what
      // this person was asked and what they answered.
      const consent = await tx.locationConsent.updateMany({
        where: { userId: citizenId },
        data: {
          latitude: null,
          longitude: null,
          accuracyM: null,
          capturedAt: null,
          userAgent: null,
          userName: null,
        },
      });

      const unclaimed = await tx.vehicle.updateMany({
        where: { ownerUserId: citizenId },
        data: { ownerUserId: null },
      });

      await tx.user.update({
        where: { id: citizenId },
        data: {
          name: ERASED_NAME,
          email: null,
          phone: null,
          passwordHash: null,
          twoFactorSecret: null,
          twoFactorEnabled: false,
          status: UserStatus.INACTIVE,
          deletedAt: now,
        },
      });

      return {
        vehiclesUnclaimed: unclaimed.count,
        notificationsRedacted: notifications.count,
        feedbackCommentsRemoved: feedback.count,
        signInRecordsRedacted: authEvents.count,
        devicesDeleted: devices.count,
        favouritesDeleted: favourites.count,
        loginSessionsDeleted: loginSessions.count,
        trustedLocationsDeleted: trusted.count,
        consentFixesCleared: consent.count,
      };
    });

    const result = {
      erased: true,
      citizenId,
      erasedAt: now.toISOString(),
      ...redactions,
      evidenceFilesDestroyed: evidence.destroyed,
      evidenceFilesHeldBack: evidence.heldBack,
      /**
       * Said plainly, because it is the part a citizen is most likely to
       * challenge and the part an officer must be able to explain.
       */
      retained:
        "Parking sessions, payments, receipts, settlement lines and ledger entries are kept. " +
        "They are tax and accounting records the authority is required to hold, and they now " +
        "refer to an account that identifies nobody.",
    };

    await this.audit.record({
      actor: officer,
      action: "DATA_SUBJECT_ERASURE",
      entity: "User",
      entityId: citizenId,
      // The name and number are what was destroyed, so they are exactly what
      // must not be copied into a row with a seven-year retention period.
      before: { hadEmail: Boolean(subject.email), hadPhone: Boolean(subject.phone), status: subject.status },
      after: { ...redactions, evidenceFilesDestroyed: evidence.destroyed, reason: dto.reason },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      requestId: ctx.requestId,
    });

    return result;
  }

  /**
   * Why this account cannot be erased right now, in the words an officer will
   * repeat to the person on the telephone.
   *
   * All of them at once rather than the first one found: being told to close a
   * dispute, and then on the second attempt that there is also an unpaid
   * session, is how a five-minute job becomes a week of correspondence.
   */
  private async erasureBlockers(citizenId: string, vehicleIds: string[]) {
    const sessionFilter = vehicleIds.length ? { vehicleId: { in: vehicleIds } } : { id: "" };

    const [inFlight, openIncidents, pending, livePasses] = await Promise.all([
      this.prisma.parkingSession.count({
        where: { ...sessionFilter, status: { in: IN_FLIGHT } },
      }),
      this.prisma.incident.count({
        where: { reportedById: citizenId, status: { in: OPEN_INCIDENT } },
      }),
      this.prisma.payment.count({
        where: {
          status: PaymentStatus.PENDING,
          OR: [
            { paidByUserId: citizenId },
            ...(vehicleIds.length ? [{ session: { vehicleId: { in: vehicleIds } } }] : []),
          ],
        },
      }),
      this.prisma.pass.count({
        where: { userId: citizenId, status: PassStatus.ACTIVE, validTo: { gte: new Date() } },
      }),
    ]);

    const blockers: { field: string; issue: string }[] = [];
    if (inFlight > 0) {
      blockers.push({
        field: "sessions",
        issue: `${inFlight} parking session(s) are still active, in overstay or under dispute`,
      });
    }
    if (openIncidents > 0) {
      blockers.push({
        field: "incidents",
        issue: `${openIncidents} incident(s) they raised are still open`,
      });
    }
    if (pending > 0) {
      blockers.push({ field: "payments", issue: `${pending} payment(s) have not been captured` });
    }
    if (livePasses > 0) {
      blockers.push({
        field: "passes",
        issue: `${livePasses} pass(es) are still valid — cancel or let them expire first`,
      });
    }
    return blockers;
  }

  // ------------------------------------------------------------- correction

  /**
   * A citizen may correct inaccurate personal data about themselves.
   *
   * Deliberately narrow: name, mobile number and email address, which are the
   * only fields on this account a person can be wrong about in a way that is
   * theirs to fix. Their parking history is not "inaccurate personal data" to
   * be edited here — a fare somebody disputes is corrected through the dispute
   * route, where a decision is recorded and a refund can follow, not by
   * rewriting what the record says happened.
   *
   * Both before and after go into the audit trail. A correction that cannot be
   * shown to have been a correction is indistinguishable from tampering with
   * somebody's account, and this route is reachable by any officer holding
   * `user.manage`.
   */
  async correct(citizenId: string, dto: CorrectCitizenDto, officer: AuthenticatedUser, ctx: Ctx) {
    const subject = await this.subject(citizenId);

    const data: Prisma.UserUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.phone !== undefined) data.phone = dto.phone === null ? null : dto.phone;
    if (dto.email !== undefined) data.email = dto.email === null ? null : dto.email;

    if (Object.keys(data).length === 0) {
      throw new AppException(
        "VALIDATION_FAILED",
        [{ field: "body", issue: "nothing to correct" }],
        "Supply at least one of name, phone or email.",
      );
    }

    let updated;
    try {
      updated = await this.prisma.user.update({
        where: { id: citizenId },
        data,
        select: { id: true, name: true, phone: true, email: true, status: true, updatedAt: true },
      });
    } catch (error) {
      // `phone` and `email` are unique across every account on the platform,
      // staff included. A collision is the caller's mistake to fix, not a 500.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const field = (error.meta?.target as string[] | undefined)?.[0] ?? "phone";
        throw new AppException(
          "DUPLICATE_RESOURCE",
          [{ field, issue: "already belongs to another account" }],
          "Another account already uses that number or address.",
        );
      }
      throw error;
    }

    await this.audit.record({
      actor: officer,
      action: "DATA_SUBJECT_CORRECTION",
      entity: "User",
      entityId: citizenId,
      before: { name: subject.name, phone: subject.phone, email: subject.email },
      after: { name: updated.name, phone: updated.phone, email: updated.email, reason: dto.reason },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      requestId: ctx.requestId,
    });

    return updated;
  }

  // ------------------------------------------------------------------ shared

  /**
   * The citizen these rights are being exercised over.
   *
   * Scoped to the CITIZEN role, and to accounts not already erased. A staff
   * account is administered through `/users`, and pointing a subject-access
   * export at one would be a neat way to read a colleague's record.
   */
  private async subject(citizenId: string) {
    const user = await this.prisma.user.findFirst({
      where: { id: citizenId, role: SYSTEM_ROLES.CITIZEN, deletedAt: null },
      select: {
        id: true,
        name: true,
        phone: true,
        email: true,
        status: true,
        role: true,
        twoFactorEnabled: true,
        createdAt: true,
        updatedAt: true,
        lastLoginAt: true,
      },
    });
    if (!user) throw AppException.notFound("citizen");
    return user;
  }
}
