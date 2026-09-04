import { Injectable } from "@nestjs/common";
import { MediaPurpose } from "@prisma/client";

import { PrismaService } from "@/prisma/prisma.service";
import { AppException } from "@/common/errors/app.exception";
import { RolesService } from "@/common/rbac/roles.service";
import { zoneScopeOf } from "@/common/rbac/scope";
import type { Permission } from "@/common/rbac/permissions";
import type { AuthenticatedUser } from "@/common/decorators/auth.decorators";

/** The stored fields the decision needs. Anything else about the file is irrelevant to it. */
export interface ReadableMedia {
  id: string;
  purpose: MediaPurpose;
  uploadedById: string | null;
}

/**
 * Who a particular file belongs to, resolved from the record that refers to it.
 *
 * A `Media` row carries no back-reference — it does not know it is the evidence
 * photograph on a session or the PAN card on a vendor. Ownership therefore has
 * to be read from the other direction, which is what `resolve` below does.
 */
interface Claim {
  /** People the file is *about*, who may read it whatever their role. */
  userIds?: (string | null | undefined)[];
  /** The vendor whose file this is. Matches a vendor or one of its attendants. */
  vendorId?: string | null;
  /** The attendant who recorded it. */
  attendantId?: string | null;
  /** The zone it happened in, so zone-scoped staff stay inside their patch. */
  zoneId?: string | null;
  /** The grant that lets back-office staff read it. Absent means nobody but the owner. */
  permission?: Permission;
}

/**
 * The rule per purpose, before any record has been consulted.
 *
 * Written as a total map on purpose: adding a `MediaPurpose` to the schema
 * without deciding who may read it will fail to compile here rather than
 * quietly inherit somebody else's rule.
 *
 * A file that no record refers to yet — uploaded and confirmed, but not
 * attached — falls back to this entry alone, which is why PROFILE is empty: a
 * profile photograph belongs to the person in it and to nobody else.
 */
const DEFAULT_CLAIM: Record<MediaPurpose, Claim> = {
  [MediaPurpose.SESSION_EVIDENCE_START]: { permission: "session.read" },
  [MediaPurpose.SESSION_EVIDENCE_END]: { permission: "session.read" },
  [MediaPurpose.KYC_DOCUMENT]: { permission: "vendor.read" },
  [MediaPurpose.AGREEMENT]: { permission: "vendor.read" },
  [MediaPurpose.INCIDENT_PHOTO]: { permission: "incident.manage" },
  [MediaPurpose.RECEIPT]: { permission: "payment.read" },
  [MediaPurpose.REPORT_EXPORT]: { permission: "report.generate" },
  [MediaPurpose.PROFILE]: {},
  // The generated documents. Each takes the grant its own resource takes, not
  // report.generate: a vendor may read the statement that pays it and has
  // never held report.generate, and an attendant may read the slip they are
  // accountable for.
  [MediaPurpose.SETTLEMENT_STATEMENT]: { permission: "settlement.read" },
  [MediaPurpose.SHIFT_SLIP]: { permission: "session.read" },
  // Signage is a notice for a pole. It carries nothing private — a published
  // tariff and a zone's own QR — so the grant that admits someone to the zone
  // admits them to its board.
  [MediaPurpose.ZONE_SIGNAGE]: { permission: "zone.read" },
};

const REFUSAL =
  "This file is not yours to open. A read link is only issued to the people the file is about " +
  "and to staff whose role covers it.";

/**
 * Whether a signed read URL may be minted for a given file.
 *
 * The bucket holds vendor PAN cards, bank proofs and photographs of private
 * vehicles at a known place and time. A signed URL is a bearer credential for
 * those bytes, so issuing one is the access decision — there is nothing else
 * downstream to stop it, and once minted it cannot be recalled.
 *
 * Resolution is batched by purpose rather than done per file: a document panel
 * asks for six at a time and an evidence strip for two, and a loop of single
 * lookups would put a round trip to Neon behind each thumbnail.
 */
@Injectable()
export class MediaAccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly roles: RolesService,
  ) {}

  /**
   * Refuses the whole request unless every file is readable by this user.
   *
   * All-or-nothing deliberately: if the batch route dropped the files it could
   * not authorise and signed the rest, it would be a working oracle for which
   * ids exist and an easy way to slip one forbidden id past a check the
   * single-item route applies.
   */
  async assertMayRead(rows: ReadableMedia[], user: AuthenticatedUser): Promise<void> {
    if (rows.length === 0) return;

    // A superuser is the break-glass account. It answers for everything.
    if (await this.roles.isSuperuser(user.role)) return;

    const claims = await this.resolve(rows);

    for (const row of rows) {
      const claim = { ...DEFAULT_CLAIM[row.purpose], ...(claims.get(row.id) ?? {}) };
      if (!(await this.mayRead(row, claim, user))) {
        throw AppException.forbidden(REFUSAL);
      }
    }
  }

  private async mayRead(
    media: ReadableMedia,
    claim: Claim,
    user: AuthenticatedUser,
  ): Promise<boolean> {
    // You uploaded the bytes, so you have already seen them. This is also what
    // keeps the two-step upload working: a vendor must be able to preview the
    // PAN card it just confirmed, in the seconds before it is attached to the
    // vendor record and becomes resolvable by any other route.
    if (media.uploadedById && media.uploadedById === user.id) return true;

    if (claim.userIds?.some((id) => id && id === user.id)) return true;
    if (claim.attendantId && user.attendantId && claim.attendantId === user.attendantId) return true;
    if (claim.vendorId && user.vendorId && claim.vendorId === user.vendorId) return true;

    if (!claim.permission) return false;

    // A vendor holds session.read and payment.read, and an attendant holds
    // session.read, so that each can work its own kerb. Those grants must not
    // widen into everybody else's evidence and receipts — for a field account
    // the vendor match above is the whole of its access.
    if (user.vendorId || user.attendantId) return false;

    if (!(await this.roles.can(user.role, claim.permission))) return false;

    // Zone-scoped staff see their own zones, scoped exactly as the session and
    // payment lists scope them — including the case of an officer with no zones
    // allocated, who sees nothing rather than everything.
    //
    // A file with no zone of its own, such as a vendor's KYC document, is not
    // narrowed by this: zone scope has nothing to say about it, and the
    // covering permission is what admits the caller.
    const zones = zoneScopeOf(user);
    if (zones && claim.zoneId) return zones.includes(claim.zoneId);

    return true;
  }

  /** One query per kind of referencing record, not one per file. */
  private async resolve(rows: ReadableMedia[]): Promise<Map<string, Claim>> {
    const claims = new Map<string, Claim>();
    const idsFor = (...purposes: MediaPurpose[]): string[] =>
      rows.filter((row) => purposes.includes(row.purpose)).map((row) => row.id);

    const evidence = idsFor(MediaPurpose.SESSION_EVIDENCE_START, MediaPurpose.SESSION_EVIDENCE_END);
    if (evidence.length > 0) {
      const sessions = await this.prisma.parkingSession.findMany({
        where: {
          OR: [
            { evidenceStartMediaId: { in: evidence } },
            { evidenceEndMediaId: { in: evidence } },
          ],
        },
        select: {
          evidenceStartMediaId: true,
          evidenceEndMediaId: true,
          zoneId: true,
          vendorId: true,
          attendantId: true,
          // The citizen who claimed this plate in the app. A photograph of
          // somebody's car outside their house is theirs to see.
          vehicle: { select: { ownerUserId: true } },
        },
      });

      for (const session of sessions) {
        const claim: Claim = {
          userIds: [session.vehicle?.ownerUserId],
          vendorId: session.vendorId,
          attendantId: session.attendantId,
          zoneId: session.zoneId,
        };
        for (const id of [session.evidenceStartMediaId, session.evidenceEndMediaId]) {
          if (id && evidence.includes(id)) claims.set(id, claim);
        }
      }
    }

    // KYC and agreements hang off VendorDocument.
    const documents = idsFor(MediaPurpose.KYC_DOCUMENT, MediaPurpose.AGREEMENT);
    if (documents.length > 0) {
      const rowsFound = await this.prisma.vendorDocument.findMany({
        where: { mediaId: { in: documents } },
        select: { mediaId: true, vendorId: true },
      });
      for (const doc of rowsFound) claims.set(doc.mediaId, { vendorId: doc.vendorId });
    }

    const photos = idsFor(MediaPurpose.INCIDENT_PHOTO);
    if (photos.length > 0) {
      const incidents = await this.prisma.incident.findMany({
        where: { mediaIds: { hasSome: photos } },
        select: { mediaIds: true, reportedById: true, zoneId: true },
      });
      for (const incident of incidents) {
        for (const id of incident.mediaIds) {
          if (photos.includes(id)) {
            claims.set(id, { userIds: [incident.reportedById], zoneId: incident.zoneId });
          }
        }
      }
    }

    const receipts = idsFor(MediaPurpose.RECEIPT);
    if (receipts.length > 0) {
      const rowsFound = await this.prisma.receipt.findMany({
        where: { pdfMediaId: { in: receipts } },
        select: {
          pdfMediaId: true,
          payment: {
            select: {
              paidByUserId: true,
              session: { select: { zoneId: true, vendorId: true } },
            },
          },
        },
      });
      for (const receipt of rowsFound) {
        if (!receipt.pdfMediaId) continue;
        claims.set(receipt.pdfMediaId, {
          userIds: [receipt.payment.paidByUserId],
          vendorId: receipt.payment.session?.vendorId,
          zoneId: receipt.payment.session?.zoneId,
        });
      }
    }

    // A settlement statement belongs to the vendor it pays, whatever else the
    // caller's role says. This is the lookup the RECEIPT branch above does, on
    // the other column that was designed to hold a generated document.
    const statements = idsFor(MediaPurpose.SETTLEMENT_STATEMENT);
    if (statements.length > 0) {
      const rowsFound = await this.prisma.settlement.findMany({
        where: { statementMediaId: { in: statements } },
        select: { statementMediaId: true, vendorId: true },
      });
      for (const row of rowsFound) {
        if (row.statementMediaId) claims.set(row.statementMediaId, { vendorId: row.vendorId });
      }
    }

    // A shift slip is the attendant's own account of the cash they handed over.
    // They may read it, their employer may read it, and zone-scoped staff see
    // it only for the zone it was worked in.
    const slips = idsFor(MediaPurpose.SHIFT_SLIP);
    if (slips.length > 0) {
      const rowsFound = await this.prisma.shift.findMany({
        where: { slipMediaId: { in: slips } },
        select: { slipMediaId: true, attendantId: true, vendorId: true, zoneId: true },
      });
      for (const row of rowsFound) {
        if (!row.slipMediaId) continue;
        claims.set(row.slipMediaId, {
          attendantId: row.attendantId,
          vendorId: row.vendorId,
          zoneId: row.zoneId,
        });
      }
    }

    // Signage is resolved for its zone so a zone officer stays inside their
    // patch, and for the vendor currently holding the zone — they are the
    // people who will actually print and mount it.
    const signage = idsFor(MediaPurpose.ZONE_SIGNAGE);
    if (signage.length > 0) {
      const zones = await this.prisma.zone.findMany({
        where: { signageMediaId: { in: signage } },
        select: {
          id: true,
          signageMediaId: true,
          vendorZones: { where: { endedAt: null }, select: { vendorId: true }, take: 1 },
        },
      });
      for (const zone of zones) {
        if (!zone.signageMediaId) continue;
        claims.set(zone.signageMediaId, {
          zoneId: zone.id,
          vendorId: zone.vendorZones[0]?.vendorId ?? null,
        });
      }
    }

    const exports = idsFor(MediaPurpose.REPORT_EXPORT);
    if (exports.length > 0) {
      const jobs = await this.prisma.reportJob.findMany({
        where: { resultMediaId: { in: exports } },
        select: { resultMediaId: true, requestedById: true },
      });
      for (const job of jobs) {
        if (job.resultMediaId) claims.set(job.resultMediaId, { userIds: [job.requestedById] });
      }
    }

    return claims;
  }
}
