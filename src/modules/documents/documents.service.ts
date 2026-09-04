import { Injectable, Logger } from "@nestjs/common";
import { MediaPurpose, Prisma, ReportStatus } from "@prisma/client";

import { PrismaService } from "@/prisma/prisma.service";
import { AppException } from "@/common/errors/app.exception";
import { AuditService } from "@/common/services/audit.service";
import { SYSTEM_ROLES } from "@/common/rbac/permissions";
import { scoped, zoneScopeOf } from "@/common/rbac/scope";
import type { AuthenticatedUser } from "@/common/decorators/auth.decorators";
import { MediaService } from "../media/media.service";
import { digestOf } from "./digest.util";
import { renderReceipt, type ReceiptContent } from "./receipt.document";
import { renderSettlement, type SettlementContent } from "./settlement.document";
import { renderShiftSlip, type ShiftSlipContent } from "./shift-slip.document";
import { renderZoneSignage, type ZoneSignageContent } from "./zone-signage.document";
import { renderAuditTrail, type AuditTrailContent } from "./audit-trail.document";
import type { AuditTrailQueryDto } from "./dto/document.dto";

type Ctx = { ip?: string; requestId?: string };

/** What every document route hands back. */
export interface IssuedDocument {
  mediaId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  /** A short-lived read URL. The bucket is not public. */
  url: string;
  expiresInSeconds: number;
  /** The fingerprint of the record the document renders. */
  digest: string;
  /** False when the stored file was reused rather than rendered again. */
  regenerated: boolean;
}

/** The cap on one audit export, stated on the document rather than applied silently. */
const AUDIT_EXPORT_CAP = 2000;

/**
 * Generated documents: receipts, settlement statements, shift slips, tariff
 * boards and the audit-trail export.
 *
 * ## Store, do not stream
 *
 * Every document is rendered once, put in object storage through MediaService,
 * and handed back as a short-lived signed URL. Nothing is streamed through this
 * API. Two reasons. A receipt is a tax document, so the bytes a citizen was
 * given have to still exist when somebody disputes the fare eighteen months
 * later — streaming would mean the "same" receipt was re-rendered by whatever
 * code was deployed that day. And the signed URL is what makes the read
 * authorisation work: MediaAccessService decides who may be issued one, per
 * file, and it needs the file to be a record rather than a response body.
 *
 * ## How regeneration is decided
 *
 * The object key *is* the fingerprint of the content:
 *
 *     receipt/2026/09/04/<sha256 of the canonicalised record>.pdf
 *
 * So asking for the same receipt twice asks for the same address. If a row is
 * already stored there, it is reused; if the underlying record has changed —
 * a refund posted against the payment, a settlement line added, a tariff
 * republished — the digest changes, the address changes, and a new document is
 * rendered. There is no cache to invalidate and no "is it stale?" heuristic to
 * get wrong, because the question "has the record changed?" and the question
 * "where does this document live?" have the same answer.
 *
 * The owning row (`Receipt.pdfMediaId`, `Settlement.statementMediaId`,
 * `Shift.slipMediaId`, `Zone.signageMediaId`) is repointed at the new file. The
 * superseded one is left in the bucket deliberately: a receipt that was handed
 * to somebody must remain resolvable even after it has been superseded.
 */
@Injectable()
export class DocumentsService {
  private readonly logger = new Logger(DocumentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly media: MediaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Render-or-reuse, store, repoint the owning row, sign.
   *
   * The order matters at the end: the owning row is repointed *before* the URL
   * is signed, because MediaAccessService reads ownership from that column. Sign
   * first and a vendor would be refused the statement that pays them, on the
   * grounds that nothing yet said it was theirs.
   */
  private async issue<T>(options: {
    purpose: MediaPurpose;
    /** The record's own date, so the storage key stays deterministic. */
    anchor: Date;
    content: T;
    render: (content: T, digest: string) => Promise<Uint8Array>;
    filename: string;
    /** Writes the media id onto the owning row. */
    persist: (mediaId: string) => Promise<void>;
    immutable?: boolean;
    audit: { action: string; entity: string; entityId: string; after?: Record<string, unknown> };
    user: AuthenticatedUser;
    ctx: Ctx;
  }): Promise<IssuedDocument> {
    const digest = digestOf(options.content);
    const key = this.media.documentKey(options.purpose, options.anchor, digest);

    const existing = await this.media.findByKey(key);
    const stored =
      existing ??
      (await this.media.storeGenerated({
        key,
        body: await options.render(options.content, digest),
        mimeType: "application/pdf",
        purpose: options.purpose,
        uploadedById: options.user.id,
        immutable: options.immutable,
      }));

    await options.persist(stored.id);

    if (!existing) {
      this.logger.log(
        `Rendered ${options.purpose} ${options.audit.entityId} at ${key} (${stored.sizeBytes} bytes)`,
      );
      await this.audit.record({
        actor: options.user,
        action: options.audit.action,
        entity: options.audit.entity,
        entityId: options.audit.entityId,
        after: { mediaId: stored.id, digest, ...options.audit.after },
        ...options.ctx,
      });
    }

    const signed = await this.media.signedUrl(stored.id, options.user);

    return {
      mediaId: stored.id,
      filename: options.filename,
      mimeType: "application/pdf",
      sizeBytes: stored.sizeBytes,
      url: signed.url,
      expiresInSeconds: signed.expiresInSeconds,
      digest,
      regenerated: !existing,
    };
  }

  // ------------------------------------------------------------------ receipt

  private paymentScope(user: AuthenticatedUser): Prisma.PaymentWhereInput {
    if (user.role === SYSTEM_ROLES.VENDOR && user.vendorId) {
      return { session: { vendorId: user.vendorId } };
    }
    const zones = zoneScopeOf(user);
    return zones ? { session: { zoneId: { in: zones } } } : {};
  }

  /**
   * The receipt for one payment.
   *
   * Every figure is lifted from the stored session and payment rows. The fare
   * breakdown is the JSON QuoteService wrote when the session ended, not a
   * fresh quote — a receipt reprinted after a tariff change must still say what
   * the citizen was actually charged.
   */
  async receipt(paymentId: string, user: AuthenticatedUser, ctx: Ctx): Promise<IssuedDocument> {
    const payment = await this.prisma.payment.findFirst({
      where: scoped<Prisma.PaymentWhereInput>(this.paymentScope(user), { id: paymentId }),
      select: {
        id: true,
        amount: true,
        refundedAmount: true,
        mode: true,
        paidAt: true,
        receipt: {
          select: { id: true, number: true, gstInvoiceNo: true, issuedAt: true },
        },
        session: {
          select: {
            code: true,
            plateNumber: true,
            startAt: true,
            endAt: true,
            durationMinutes: true,
            grossAmount: true,
            discountAmount: true,
            penaltyAmount: true,
            taxAmount: true,
            payableAmount: true,
            fareBreakdown: true,
            vehicleType: { select: { label: true } },
            zone: { select: { name: true, code: true, ward: { select: { name: true } } } },
            vendor: { select: { orgName: true, gstin: true } },
          },
        },
      },
    });

    if (!payment) throw AppException.notFound("payment");
    if (!payment.receipt) {
      throw new AppException(
        "VALIDATION_FAILED",
        [{ field: "paymentId", issue: "no receipt has been issued for this payment" }],
        "No receipt has been issued for this payment yet. Issue it first, then download it.",
      );
    }
    if (!payment.session) {
      throw new AppException(
        "VALIDATION_FAILED",
        [{ field: "paymentId", issue: "not attached to a parking session" }],
        "This payment is not for a parking session, so there is no parking receipt to render.",
      );
    }

    const session = payment.session;
    const quote = this.fareLines(session.fareBreakdown);

    const content: ReceiptContent = {
      receiptNumber: payment.receipt.number,
      gstInvoiceNo: payment.receipt.gstInvoiceNo,
      issuedAt: payment.receipt.issuedAt,
      sessionCode: session.code,
      plateNumber: session.plateNumber,
      vehicleType: session.vehicleType?.label ?? "Vehicle",
      zoneName: session.zone?.name ?? "-",
      zoneCode: session.zone?.code ?? "-",
      wardName: session.zone?.ward?.name ?? null,
      startAt: session.startAt,
      endAt: session.endAt,
      durationMinutes: session.durationMinutes,
      lines: quote.lines,
      grossAmount: session.grossAmount ?? 0,
      discountAmount: session.discountAmount,
      penaltyAmount: session.penaltyAmount,
      taxAmount: session.taxAmount,
      taxPercent: quote.taxPercent,
      payableAmount: session.payableAmount ?? 0,
      paidAmount: payment.amount,
      refundedAmount: payment.refundedAmount,
      paymentMode: payment.mode,
      paidAt: payment.paidAt,
      vendorName: session.vendor?.orgName ?? "-",
      vendorGstin: session.vendor?.gstin ?? null,
    };

    const receiptId = payment.receipt.id;
    return this.issue({
      purpose: MediaPurpose.RECEIPT,
      anchor: payment.receipt.issuedAt,
      content,
      render: renderReceipt,
      filename: `${payment.receipt.number.replace(/[^A-Za-z0-9]+/g, "-")}.pdf`,
      // A receipt that has been handed to a citizen must never be replaced in
      // the bucket. A corrected one is a new file at a new address.
      immutable: true,
      persist: async (mediaId) => {
        await this.prisma.receipt.update({ where: { id: receiptId }, data: { pdfMediaId: mediaId } });
      },
      audit: {
        action: "RECEIPT_DOCUMENT_ISSUE",
        entity: "Receipt",
        entityId: receiptId,
        after: { number: payment.receipt.number, sessionCode: session.code },
      },
      user,
      ctx,
    });
  }

  /**
   * The stored fare breakdown, defensively.
   *
   * `fareBreakdown` is a JSON column written by QuoteService. It is trusted to
   * be a Quote, but a row written by an older version of that engine may be
   * missing a field, and a receipt is not the place to throw over a shape
   * mismatch. Whatever cannot be read falls back to the session's own columns,
   * which are the figures the money moved against anyway.
   */
  private fareLines(raw: Prisma.JsonValue | null): {
    lines: { code: string; label: string; amount: number }[];
    taxPercent: number;
  } {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { lines: [], taxPercent: 0 };
    const quote = raw as Record<string, unknown>;
    const rawLines = Array.isArray(quote.lines) ? quote.lines : [];

    const lines = rawLines.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const line = entry as Record<string, unknown>;
      if (typeof line.amount !== "number") return [];
      return [
        {
          code: typeof line.code === "string" ? line.code : "LINE",
          label: typeof line.label === "string" ? line.label : "Charge",
          amount: line.amount,
        },
      ];
    });

    return { lines, taxPercent: typeof quote.taxPercent === "number" ? quote.taxPercent : 0 };
  }

  // --------------------------------------------------------------- settlement

  private settlementScope(user: AuthenticatedUser): Prisma.SettlementWhereInput {
    if (user.role === SYSTEM_ROLES.VENDOR && user.vendorId) return { vendorId: user.vendorId };
    return {};
  }

  private settlementReference(settlement: { id: string; periodStart: Date }): string {
    const period = settlement.periodStart.toISOString().slice(0, 7).replace("-", "");
    return `STL-${period}-${settlement.id.slice(-4).toUpperCase()}`;
  }

  async settlementStatement(
    id: string,
    user: AuthenticatedUser,
    ctx: Ctx,
  ): Promise<IssuedDocument> {
    const settlement = await this.prisma.settlement.findFirst({
      where: scoped<Prisma.SettlementWhereInput>(this.settlementScope(user), { id }),
      select: {
        id: true,
        status: true,
        periodStart: true,
        periodEnd: true,
        grossCollected: true,
        cashCollected: true,
        digitalCollected: true,
        commissionAmount: true,
        vendorShare: true,
        governmentShare: true,
        approvedBy: true,
        approvedAt: true,
        payoutRef: true,
        payoutStatus: true,
        createdAt: true,
        vendor: {
          select: {
            orgName: true,
            gstin: true,
            commissionPct: true,
            bankAccountNo: true,
            bankIfsc: true,
          },
        },
      },
    });
    if (!settlement) throw AppException.notFound("settlement");

    const lines = await this.prisma.settlementLine.findMany({
      where: { settlementId: id },
      select: {
        amount: true,
        commission: true,
        payment: {
          select: {
            id: true,
            mode: true,
            paidAt: true,
            session: { select: { code: true, plateNumber: true } },
          },
        },
      },
      orderBy: { payment: { paidAt: "asc" } },
    });

    // The approver is stored as a user id; the statement needs a name on it.
    const approver = settlement.approvedBy
      ? await this.prisma.user.findUnique({
          where: { id: settlement.approvedBy },
          select: { name: true },
        })
      : null;

    const content: SettlementContent = {
      reference: this.settlementReference(settlement),
      settlementId: settlement.id,
      status: settlement.status,
      periodStart: settlement.periodStart,
      periodEnd: settlement.periodEnd,
      generatedAt: new Date(),
      vendorName: settlement.vendor?.orgName ?? "-",
      vendorGstin: settlement.vendor?.gstin ?? null,
      commissionPct: Number(settlement.vendor?.commissionPct ?? 0),
      bankAccountNo: settlement.vendor?.bankAccountNo ?? null,
      bankIfsc: settlement.vendor?.bankIfsc ?? null,
      grossCollected: settlement.grossCollected,
      cashCollected: settlement.cashCollected,
      digitalCollected: settlement.digitalCollected,
      commissionAmount: settlement.commissionAmount,
      vendorShare: settlement.vendorShare,
      governmentShare: settlement.governmentShare,
      approvedBy: approver?.name ?? null,
      approvedAt: settlement.approvedAt,
      payoutRef: settlement.payoutRef,
      payoutStatus: settlement.payoutStatus,
      lines: lines.map((line) => ({
        paymentId: line.payment.id,
        sessionCode: line.payment.session?.code ?? null,
        plateNumber: line.payment.session?.plateNumber ?? null,
        mode: line.payment.mode,
        paidAt: line.payment.paidAt,
        amount: line.amount,
        commission: line.commission,
      })),
    };

    return this.issue({
      purpose: MediaPurpose.SETTLEMENT_STATEMENT,
      anchor: settlement.periodStart,
      // `generatedAt` is deliberately excluded from the digest by re-deriving
      // it here: were the timestamp part of the content, every download would
      // hash differently and nothing would ever be reused.
      content: { ...content, generatedAt: settlement.createdAt },
      render: (value, digest) => renderSettlement({ ...value, generatedAt: new Date() }, digest),
      filename: `${content.reference}.pdf`,
      persist: async (mediaId) => {
        await this.prisma.settlement.update({ where: { id }, data: { statementMediaId: mediaId } });
      },
      audit: {
        action: "SETTLEMENT_STATEMENT_ISSUE",
        entity: "Settlement",
        entityId: id,
        after: { reference: content.reference, lines: content.lines.length },
      },
      user,
      ctx,
    });
  }

  // -------------------------------------------------------------------- shift

  private shiftScope(user: AuthenticatedUser): Prisma.ShiftWhereInput {
    if (user.role === SYSTEM_ROLES.VENDOR && user.vendorId) return { vendorId: user.vendorId };
    if (user.role === SYSTEM_ROLES.ATTENDANT && user.attendantId) {
      return { attendantId: user.attendantId };
    }
    const zones = zoneScopeOf(user);
    return zones ? { zoneId: { in: zones } } : {};
  }

  async shiftSlip(id: string, user: AuthenticatedUser, ctx: Ctx): Promise<IssuedDocument> {
    const shift = await this.prisma.shift.findFirst({
      where: scoped<Prisma.ShiftWhereInput>(this.shiftScope(user), { id }),
      select: {
        id: true,
        status: true,
        startAt: true,
        endAt: true,
        sessionsCount: true,
        cashExpected: true,
        cashDeposited: true,
        digitalTotal: true,
        varianceAmount: true,
        verifiedBy: true,
        verifiedAt: true,
        attendant: {
          select: { employeeCode: true, user: { select: { name: true, phone: true } } },
        },
        vendor: { select: { orgName: true } },
        zone: { select: { name: true, code: true } },
      },
    });
    if (!shift) throw AppException.notFound("shift");

    const verifier = shift.verifiedBy
      ? await this.prisma.user.findUnique({
          where: { id: shift.verifiedBy },
          select: { name: true },
        })
      : null;

    const durationMinutes = shift.endAt
      ? Math.max(0, Math.round((shift.endAt.getTime() - shift.startAt.getTime()) / 60_000))
      : null;

    const content: ShiftSlipContent = {
      shiftId: shift.id,
      reference: `SHIFT-${shift.id.slice(-6).toUpperCase()}`,
      status: shift.status,
      generatedAt: new Date(),
      attendantName: shift.attendant?.user.name ?? "-",
      employeeCode: shift.attendant?.employeeCode ?? "-",
      attendantPhone: shift.attendant?.user.phone ?? null,
      vendorName: shift.vendor?.orgName ?? "-",
      zoneName: shift.zone?.name ?? null,
      zoneCode: shift.zone?.code ?? null,
      startAt: shift.startAt,
      endAt: shift.endAt,
      durationMinutes,
      sessionsCount: shift.sessionsCount,
      cashExpected: shift.cashExpected,
      cashDeposited: shift.cashDeposited,
      digitalTotal: shift.digitalTotal,
      varianceAmount: shift.varianceAmount,
      verifiedBy: verifier?.name ?? null,
      verifiedAt: shift.verifiedAt,
    };

    return this.issue({
      purpose: MediaPurpose.SHIFT_SLIP,
      anchor: shift.startAt,
      content: { ...content, generatedAt: shift.startAt },
      render: (value, digest) => renderShiftSlip({ ...value, generatedAt: new Date() }, digest),
      filename: `${content.reference}.pdf`,
      persist: async (mediaId) => {
        await this.prisma.shift.update({ where: { id }, data: { slipMediaId: mediaId } });
      },
      audit: {
        action: "SHIFT_SLIP_ISSUE",
        entity: "Shift",
        entityId: id,
        after: { reference: content.reference, variance: shift.varianceAmount },
      },
      user,
      ctx,
    });
  }

  // ------------------------------------------------------------------- zone

  async zoneSignage(id: string, user: AuthenticatedUser, ctx: Ctx): Promise<IssuedDocument> {
    const zones = zoneScopeOf(user);
    const zone = await this.prisma.zone.findFirst({
      where: scoped<Prisma.ZoneWhereInput>(zones ? { id: { in: zones } } : {}, { id }),
      select: {
        id: true,
        code: true,
        name: true,
        capacity: true,
        openTime: true,
        closeTime: true,
        status: true,
        updatedAt: true,
        ward: { select: { name: true } },
        street: { select: { name: true } },
        vendorZones: {
          where: { endedAt: null },
          select: { vendor: { select: { orgName: true } } },
          take: 1,
        },
      },
    });
    if (!zone) throw AppException.notFound("zone");

    const now = new Date();
    // Only what is actually in force, and only what is published. A board
    // showing a draft rate is a board the authority cannot enforce.
    const tariffs = await this.prisma.tariff.findMany({
      where: {
        isPublished: true,
        effectiveFrom: { lte: now },
        OR: [{ effectiveTo: null }, { effectiveTo: { gte: now } }],
        AND: [{ OR: [{ zoneId: id }, { zoneId: null }] }],
      },
      select: {
        zoneId: true,
        priority: true,
        effectiveFrom: true,
        baseAmount: true,
        baseMinutes: true,
        incrementAmount: true,
        incrementMinutes: true,
        dailyCapAmount: true,
        gracePeriodMin: true,
        overstayPenalty: true,
        taxPercent: true,
        vehicleType: { select: { id: true, label: true, sortOrder: true } },
      },
    });

    // One rate per vehicle type, resolved the same way QuoteService resolves it
    // — zone-specific beats city-wide, then priority, then most recent — so the
    // board cannot advertise a rate the engine would not charge.
    const best = new Map<string, (typeof tariffs)[number]>();
    for (const tariff of tariffs) {
      const key = tariff.vehicleType.id;
      const current = best.get(key);
      if (!current) {
        best.set(key, tariff);
        continue;
      }
      const beats =
        Number(Boolean(tariff.zoneId)) - Number(Boolean(current.zoneId)) ||
        tariff.priority - current.priority ||
        tariff.effectiveFrom.getTime() - current.effectiveFrom.getTime();
      if (beats > 0) best.set(key, tariff);
    }

    const content: ZoneSignageContent = {
      zoneId: zone.id,
      zoneName: zone.name,
      zoneCode: zone.code,
      wardName: zone.ward?.name ?? null,
      streetName: zone.street?.name ?? null,
      capacity: zone.capacity,
      openTime: zone.openTime,
      closeTime: zone.closeTime,
      status: zone.status,
      vendorName: zone.vendorZones[0]?.vendor?.orgName ?? null,
      // The zone code, not an id: it is printed on the board beneath the code
      // and a citizen reading one should be able to type the other.
      qrPayload: `kmcp://zone/${zone.code}`,
      generatedAt: zone.updatedAt,
      tariffs: [...best.values()]
        .sort((a, b) => a.vehicleType.sortOrder - b.vehicleType.sortOrder)
        .map((tariff) => ({
          vehicleType: tariff.vehicleType.label,
          baseAmount: tariff.baseAmount,
          baseMinutes: tariff.baseMinutes,
          incrementAmount: tariff.incrementAmount,
          incrementMinutes: tariff.incrementMinutes,
          dailyCapAmount: tariff.dailyCapAmount,
          gracePeriodMin: tariff.gracePeriodMin,
          overstayPenalty: tariff.overstayPenalty,
          taxPercent: Number(tariff.taxPercent),
          effectiveFrom: tariff.effectiveFrom,
        })),
    };

    return this.issue({
      purpose: MediaPurpose.ZONE_SIGNAGE,
      anchor: zone.updatedAt,
      content,
      render: (value, digest) => renderZoneSignage({ ...value, generatedAt: new Date() }, digest),
      filename: `signage-${zone.code}.pdf`,
      persist: async (mediaId) => {
        await this.prisma.zone.update({ where: { id }, data: { signageMediaId: mediaId } });
      },
      audit: {
        action: "ZONE_SIGNAGE_ISSUE",
        entity: "Zone",
        entityId: id,
        after: { code: zone.code, tariffs: content.tariffs.length },
      },
      user,
      ctx,
    });
  }

  // ------------------------------------------------------------------- audit

  /**
   * The audit-trail export.
   *
   * The only document whose digest is recorded in the audit log as a matter of
   * course, and the reason is in `audit-trail.document.ts`: the recorded digest
   * is the whole of the tamper-evidence claim. It is written even when the file
   * is reused, so every export of a trail leaves a trace of who took it and
   * when, not merely the first one.
   */
  async auditTrail(
    query: AuditTrailQueryDto,
    user: AuthenticatedUser,
    ctx: Ctx,
  ): Promise<IssuedDocument> {
    const where: Prisma.AuditLogWhereInput = {
      createdAt: { gte: query.from, lte: query.to },
      ...(query.action ? { action: query.action } : {}),
      ...(query.entity ? { entity: query.entity } : {}),
      ...(query.entityId ? { entityId: query.entityId } : {}),
      ...(query.actorUserId ? { actorUserId: query.actorUserId } : {}),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: "asc" },
        take: AUDIT_EXPORT_CAP,
      }),
      this.prisma.auditLog.count({ where }),
    ]);

    const actorIds = [...new Set(rows.map((row) => row.actorUserId).filter(Boolean))] as string[];
    const actors = actorIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: actorIds } },
          select: { id: true, name: true, role: true },
        })
      : [];
    const byId = new Map(actors.map((actor) => [actor.id, actor]));

    const filterLabel =
      [
        query.action ? `action ${query.action}` : null,
        query.entity ? `entity ${query.entity}` : null,
        query.entityId ? `record ${query.entityId}` : null,
        query.actorUserId ? `actor ${query.actorUserId}` : null,
      ]
        .filter(Boolean)
        .join(", ") || "no filter";

    const content: AuditTrailContent = {
      from: query.from,
      to: query.to,
      filterLabel,
      requestedBy: user.name,
      generatedAt: new Date(),
      truncated: total > AUDIT_EXPORT_CAP,
      cap: AUDIT_EXPORT_CAP,
      entries: rows.map((row) => {
        const actor = row.actorUserId ? byId.get(row.actorUserId) : undefined;
        return {
          id: row.id,
          at: row.createdAt,
          actorName: actor?.name ?? "System",
          actorRole: actor?.role ?? "-",
          action: row.action,
          entity: row.entity,
          entityId: row.entityId,
          ip: row.ip,
          summary: row.after ? JSON.stringify(row.after).slice(0, 120) : "",
        };
      }),
    };

    // The digest covers the entries and the period, not who asked or when: two
    // auditors exporting the same period must arrive at the same fingerprint,
    // or comparing them proves nothing.
    const digestible = {
      from: content.from,
      to: content.to,
      filterLabel: content.filterLabel,
      truncated: content.truncated,
      entries: content.entries,
    };

    const issued = await this.issue({
      purpose: MediaPurpose.REPORT_EXPORT,
      anchor: query.from,
      content: digestible,
      render: (_value, digest) => renderAuditTrail(content, digest),
      filename: `audit-trail-${query.from.toISOString().slice(0, 10)}-to-${query.to
        .toISOString()
        .slice(0, 10)}.pdf`,
      persist: async (mediaId) => {
        // There is no owning row for an export, so a ReportJob is created as
        // one — which is also what lets MediaAccessService resolve who asked
        // for it, exactly as it does for a CSV report.
        await this.prisma.reportJob.create({
          data: {
            type: "audit-trail-pdf",
            params: {
              from: query.from.toISOString(),
              to: query.to.toISOString(),
              filter: filterLabel,
              format: "pdf",
            },
            status: ReportStatus.COMPLETED,
            requestedById: user.id,
            resultMediaId: mediaId,
            completedAt: new Date(),
          },
        });
      },
      audit: {
        action: "AUDIT_EXPORT",
        entity: "AuditLog",
        entityId: `${query.from.toISOString()}..${query.to.toISOString()}`,
        after: { entries: content.entries.length, total, filter: filterLabel, truncated: content.truncated },
      },
      user,
      ctx,
    });

    // Recorded on every export, not only the first. The claim on the paper is
    // that a generation record exists for this fingerprint at this time; a
    // reused file with no second record would make that claim false for the
    // second auditor who took it.
    if (!issued.regenerated) {
      await this.audit.record({
        actor: user,
        action: "AUDIT_EXPORT",
        entity: "AuditLog",
        entityId: `${query.from.toISOString()}..${query.to.toISOString()}`,
        after: {
          mediaId: issued.mediaId,
          digest: issued.digest,
          entries: content.entries.length,
          total,
          filter: filterLabel,
          reusedStoredDocument: true,
        },
        ...ctx,
      });
    }

    return issued;
  }
}
