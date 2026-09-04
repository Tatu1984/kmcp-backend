import { AppException } from "@/common/errors/app.exception";
import { Sheet, formatDate, formatDateTime, money } from "./pdf.util";

/** One captured payment as it appears on the statement. */
export interface StatementLine {
  paymentId: string;
  sessionCode: string | null;
  plateNumber: string | null;
  mode: string;
  paidAt: Date | null;
  /** Net of refunds, exactly as SettlementLine.amount stores it. */
  amount: number;
  commission: number;
}

export interface SettlementContent {
  reference: string;
  settlementId: string;
  status: string;
  periodStart: Date;
  periodEnd: Date;
  generatedAt: Date;

  vendorName: string;
  vendorGstin: string | null;
  commissionPct: number;
  bankAccountNo: string | null;
  bankIfsc: string | null;

  grossCollected: number;
  cashCollected: number;
  digitalCollected: number;
  commissionAmount: number;
  vendorShare: number;
  governmentShare: number;

  approvedBy: string | null;
  approvedAt: Date | null;
  payoutRef: string | null;
  payoutStatus: string | null;

  lines: StatementLine[];
}

/**
 * Refuses to print a statement that does not reconcile to its own record.
 *
 * A settlement statement is what a vendor is paid against and what the
 * authority books as revenue. If the totals on the page and the lines behind
 * them disagree by a single paisa, somebody spends a week finding out why — so
 * the disagreement is surfaced here, at generation, naming the figures, rather
 * than shipped as a tidy-looking PDF.
 *
 * Every check is against the stored `Settlement` row. Nothing is recomputed
 * from a commission percentage: rounding happens per line in the generator, and
 * re-deriving the total from the percentage would be off by a few paise on any
 * period with an odd number of odd amounts.
 */
export function reconcileSettlement(content: SettlementContent): void {
  const problems: { field: string; issue: string }[] = [];

  if (content.cashCollected + content.digitalCollected !== content.grossCollected) {
    problems.push({
      field: "grossCollected",
      issue: `cash ${content.cashCollected} + digital ${content.digitalCollected} does not equal gross ${content.grossCollected}`,
    });
  }

  if (content.vendorShare + content.governmentShare !== content.grossCollected) {
    problems.push({
      field: "governmentShare",
      issue: `vendor ${content.vendorShare} + government ${content.governmentShare} does not equal gross ${content.grossCollected}`,
    });
  }

  const lineTotal = content.lines.reduce((sum, line) => sum + line.amount, 0);
  if (lineTotal !== content.grossCollected) {
    problems.push({
      field: "lines",
      issue: `the ${content.lines.length} payment lines total ${lineTotal} but the settlement records ${content.grossCollected}`,
    });
  }

  const commissionTotal = content.lines.reduce((sum, line) => sum + line.commission, 0);
  if (commissionTotal !== content.commissionAmount) {
    problems.push({
      field: "commissionAmount",
      issue: `the per-line commission totals ${commissionTotal} but the settlement records ${content.commissionAmount}`,
    });
  }

  if (problems.length > 0) {
    throw new AppException(
      "VALIDATION_FAILED",
      problems,
      `Settlement ${content.reference} does not reconcile to its own payment lines, so no ` +
        "statement will be produced for it. This needs finance, not a retry.",
    );
  }
}

export async function renderSettlement(
  content: SettlementContent,
  digest: string,
): Promise<Uint8Array> {
  reconcileSettlement(content);

  const sheet = await Sheet.create(
    `Settlement statement ${content.reference}`,
    `${content.vendorName} · ${formatDate(content.periodStart)} to ${formatDate(content.periodEnd)}`,
  );

  sheet.masthead(
    "Settlement statement",
    `${content.vendorName} · ${formatDate(content.periodStart)} to ${formatDate(content.periodEnd)}`,
    content.reference,
  );

  sheet.particulars([
    ["Vendor", content.vendorName],
    ["Vendor GSTIN", content.vendorGstin ?? "Not registered"],
    ["Period", `${formatDate(content.periodStart)} to ${formatDate(content.periodEnd)}`],
    ["Status", content.status.replace(/_/g, " ")],
    ["Payments settled", String(content.lines.length)],
    ["Commission rate", `${content.commissionPct}%`],
    ["Bank account", content.bankAccountNo ?? "Not on file"],
    ["IFSC", content.bankIfsc ?? "Not on file"],
  ]);

  sheet.gap(14);
  sheet.line("Collection", { size: 10, bold: true });
  sheet.gap(2);
  sheet.table(
    [
      { label: "Method", flex: 4 },
      { label: "Payments", flex: 2, align: "right" },
      { label: "Amount", flex: 3, align: "right" },
    ],
    [
      [
        "Cash collected at the kerb",
        String(content.lines.filter((line) => line.mode === "CASH").length),
        money(content.cashCollected),
      ],
      [
        "Digital, received through the gateway",
        String(content.lines.filter((line) => line.mode !== "CASH").length),
        money(content.digitalCollected),
      ],
    ],
  );

  sheet.gap(6);
  sheet.totals([
    { label: "Gross collected", amount: content.grossCollected, emphasis: true },
    {
      label: `Vendor share (commission at ${content.commissionPct}%)`,
      amount: content.vendorShare,
    },
    { label: "Municipal share", amount: content.governmentShare },
  ]);

  sheet.gap(10);
  sheet.paragraph(
    "Commission is rounded on each payment individually and then totalled, which is how the " +
      "ledger posts it. The municipal share is the remainder rather than a second percentage, so " +
      "the two shares always add back to the gross exactly however each line rounded.",
    { size: 8 },
  );

  sheet.gap(14);
  sheet.line("Payment lines", { size: 10, bold: true });
  sheet.gap(2);
  sheet.table(
    [
      { label: "Paid", flex: 3 },
      { label: "Session", flex: 3 },
      { label: "Vehicle", flex: 3 },
      { label: "Method", flex: 2 },
      { label: "Amount", flex: 2, align: "right" },
      { label: "Commission", flex: 2, align: "right" },
    ],
    content.lines.map((line) => [
      line.paidAt ? formatDate(line.paidAt) : "-",
      line.sessionCode ?? "-",
      line.plateNumber ?? "-",
      line.mode.replace(/_/g, " "),
      money(line.amount),
      money(line.commission),
    ]),
    { zebra: true },
  );

  sheet.gap(4);
  sheet.totals([
    { label: `${content.lines.length} payments`, amount: content.grossCollected, emphasis: true },
  ]);

  sheet.gap(16);
  sheet.rule();
  sheet.particulars(
    [
      ["Approved by", content.approvedBy ?? "Not yet approved"],
      ["Approved on", content.approvedAt ? formatDateTime(content.approvedAt) : "-"],
      ["Payout reference", content.payoutRef ?? "Not yet paid"],
      ["Payout status", content.payoutStatus ?? "-"],
    ],
    2,
  );

  sheet.footer([
    `${content.reference} · ${content.vendorName} · ${formatDate(content.periodStart)} to ${formatDate(content.periodEnd)}`,
    `Amounts in INR. Times are IST. Generated ${formatDateTime(content.generatedAt)}. Document fingerprint ${digest.slice(0, 32)}`,
  ]);

  return sheet.save();
}
