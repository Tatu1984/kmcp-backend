import { Sheet, formatDate, formatDateTime, formatStamp } from "./pdf.util";
import { shortDigest } from "./digest.util";

/**
 * The audit-trail export.
 *
 * ## What "tamper-evident" means here, and what it does not
 *
 * The portal used to promise a "signed, tamper-evident" export and produce a
 * toast. Signed it is not — this platform holds no signing key, and a claim of
 * a cryptographic signature that is really a PDF with a logo on it is worse
 * than no claim at all to the one audience that will act on it.
 *
 * What it does have is a defensible weaker property, and the document says
 * exactly that in its own words. Before rendering, the selected entries are
 * canonicalised and hashed. That digest is printed on every page, and the same
 * digest is written into the audit log itself as an `AUDIT_EXPORT` entry naming
 * the period, the filter and the row count. So:
 *
 *   - altering a line on the paper makes it disagree with the digest printed
 *     beside it, which anybody can recompute from the same period;
 *   - altering the whole export, digest included, makes it disagree with the
 *     `AUDIT_EXPORT` entry recorded when it was generated — and that entry is
 *     in the append-only trail, which has no update or delete route at all,
 *     not even for a Super Admin;
 *   - and because generating an export is itself an audited act, an export
 *     that nobody can find a generation record for is evidence of nothing.
 *
 * That is "tamper-evident" in the sense an auditor can actually use: not that
 * the document cannot be altered, but that an alteration cannot be made to
 * agree with the record. It is not a substitute for a signature and the
 * document does not pretend to be one.
 */
export interface AuditEntryRow {
  id: string;
  at: Date;
  actorName: string;
  actorRole: string;
  action: string;
  entity: string;
  entityId: string;
  ip: string | null;
  summary: string;
}

export interface AuditTrailContent {
  from: Date;
  to: Date;
  filterLabel: string;
  requestedBy: string;
  generatedAt: Date;
  /** True when the period held more entries than the cap allows. */
  truncated: boolean;
  cap: number;
  entries: AuditEntryRow[];
}

export async function renderAuditTrail(
  content: AuditTrailContent,
  digest: string,
): Promise<Uint8Array> {
  const sheet = await Sheet.create(
    `Audit trail ${formatDate(content.from)} to ${formatDate(content.to)}`,
    "Append-only record of every change",
  );

  sheet.masthead(
    "Audit trail",
    `${formatDate(content.from)} to ${formatDate(content.to)} · ${content.filterLabel}`,
    `${content.entries.length} entries`,
  );

  sheet.particulars([
    ["Period", `${formatDateTime(content.from)} to ${formatDateTime(content.to)}`],
    ["Filter", content.filterLabel],
    ["Exported by", content.requestedBy],
    ["Exported at", formatDateTime(content.generatedAt)],
  ]);

  sheet.gap(12);
  sheet.box(48, sheet.cursor - 62, sheet.contentWidth, 58);
  sheet.gap(14);
  sheet.line("CONTENT FINGERPRINT", { size: 7.5, bold: true, color: Sheet.muted, x: 58 });
  sheet.line(shortDigest(digest), { size: 13, bold: true, x: 58 });
  sheet.line(digest, { size: 6.5, color: Sheet.muted, x: 58 });
  sheet.gap(14);

  sheet.paragraph(
    "This is a SHA-256 over the entries listed below, taken before the document was rendered. " +
      "The same fingerprint was written into the audit trail itself as an AUDIT_EXPORT entry at " +
      "the moment of generation. To check this document, re-export the same period and compare " +
      "the fingerprints, or look up the AUDIT_EXPORT entry recorded at the time above. The trail " +
      "is append-only: this API exposes no route that edits or deletes an entry.",
    { size: 8 },
  );
  sheet.paragraph(
    "This document is not cryptographically signed. It is evidence that its contents match a " +
      "record made when it was produced, and nothing more than that.",
    { size: 8, bold: true },
  );

  if (content.truncated) {
    sheet.gap(6);
    sheet.paragraph(
      `The period contains more than ${content.cap} entries. This export carries the first ` +
        `${content.cap} in time order and is therefore incomplete — narrow the period and export ` +
        "again rather than treating this as the whole trail.",
      { size: 8, bold: true },
    );
  }

  sheet.gap(14);
  sheet.table(
    [
      { label: "When (IST)", flex: 4 },
      { label: "Actor", flex: 4 },
      { label: "Role", flex: 2 },
      { label: "Action", flex: 6 },
      { label: "Record", flex: 5 },
      { label: "IP", flex: 3 },
    ],
    content.entries.map((entry) => [
      formatStamp(entry.at),
      entry.actorName,
      entry.actorRole,
      entry.action,
      `${entry.entity} ${entry.entityId}`,
      entry.ip ?? "-",
    ]),
    { zebra: true },
  );

  if (content.entries.length === 0) {
    sheet.gap(8);
    sheet.paragraph("No entries were recorded in this period.", { size: 9 });
  }

  sheet.footer([
    `Audit trail ${formatDate(content.from)} to ${formatDate(content.to)} · ${content.entries.length} entries · exported by ${content.requestedBy}`,
    `Content fingerprint (SHA-256) ${digest}`,
  ]);

  return sheet.save();
}
