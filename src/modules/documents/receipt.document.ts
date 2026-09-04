import { AppException } from "@/common/errors/app.exception";
import { Sheet, formatDate, formatDateTime, formatDuration, money } from "./pdf.util";

/**
 * Everything the receipt says, and nothing else.
 *
 * Every figure here is copied from a stored column. Nothing on this document is
 * recomputed at render time — the fare was decided once, by QuoteService, at
 * the moment the session ended, and a receipt that quietly re-derived it would
 * silently re-price historic parking whenever a tariff or a rounding rule
 * changed. That is a tax document disagreeing with the ledger, which is the one
 * failure mode this whole module exists to avoid.
 */
export interface ReceiptContent {
  receiptNumber: string;
  gstInvoiceNo: string | null;
  issuedAt: Date;

  sessionCode: string;
  plateNumber: string;
  vehicleType: string;
  zoneName: string;
  zoneCode: string;
  wardName: string | null;
  startAt: Date;
  endAt: Date | null;
  durationMinutes: number | null;

  /** The fare breakdown exactly as QuoteService computed and stored it. */
  lines: { code: string; label: string; amount: number }[];
  grossAmount: number;
  discountAmount: number;
  penaltyAmount: number;
  taxAmount: number;
  taxPercent: number;
  payableAmount: number;

  paidAmount: number;
  refundedAmount: number;
  paymentMode: string;
  paidAt: Date | null;

  vendorName: string;
  vendorGstin: string | null;
}

/**
 * Refuses to issue a receipt whose own figures disagree.
 *
 * This is a GST document. A citizen may hand it to their accountant and the
 * authority may have to defend it, so the arithmetic printed on it has to close
 * — and if the stored record cannot close, the honest response is no document
 * rather than a plausible one.
 */
export function reconcileReceipt(content: ReceiptContent): { taxableValue: number } {
  const problems: { field: string; issue: string }[] = [];

  const lineTotal = content.lines.reduce((sum, line) => sum + line.amount, 0);
  if (content.lines.length > 0 && lineTotal !== content.grossAmount) {
    problems.push({
      field: "fareBreakdown",
      issue: `the fare lines total ${lineTotal} paise but the session records ${content.grossAmount}`,
    });
  }

  if (content.grossAmount + content.taxAmount !== content.payableAmount) {
    problems.push({
      field: "payableAmount",
      issue: `${content.grossAmount} + ${content.taxAmount} tax does not equal ${content.payableAmount}`,
    });
  }

  if (content.refundedAmount > content.paidAmount) {
    problems.push({
      field: "refundedAmount",
      issue: "more has been refunded than was ever paid",
    });
  }

  if (problems.length > 0) {
    throw new AppException(
      "VALIDATION_FAILED",
      problems,
      "This payment's stored figures do not add up, so no receipt can be issued for it. " +
        "Raise it with finance rather than re-running the download.",
    );
  }

  // The taxable value is what remains once the tax is taken out of the total
  // charged — derived by subtraction so it can never disagree with either.
  return { taxableValue: content.payableAmount - content.taxAmount };
}

export async function renderReceipt(content: ReceiptContent, digest: string): Promise<Uint8Array> {
  const { taxableValue } = reconcileReceipt(content);

  const sheet = await Sheet.create(
    `Parking receipt ${content.receiptNumber}`,
    `Session ${content.sessionCode}`,
  );

  sheet.masthead(
    "Parking receipt",
    content.gstInvoiceNo ? "Tax invoice under the GST Act" : "Official receipt",
    content.receiptNumber,
  );

  sheet.particulars([
    ["Receipt number", content.receiptNumber],
    ["GST invoice number", content.gstInvoiceNo ?? "Not applicable"],
    ["Issued", formatDateTime(content.issuedAt)],
    ["Session code", content.sessionCode],
    ["Vehicle", `${content.plateNumber} (${content.vehicleType})`],
    ["Zone", `${content.zoneName} · ${content.zoneCode}`],
    ["Ward", content.wardName ?? "-"],
    ["Operator", content.vendorName],
  ]);

  sheet.gap(6);
  sheet.particulars([
    ["Parked from", formatDateTime(content.startAt)],
    ["Parked until", content.endAt ? formatDateTime(content.endAt) : "Still running"],
    ["Duration charged", formatDuration(content.durationMinutes)],
    ["Operator GSTIN", content.vendorGstin ?? "Not registered"],
  ]);

  sheet.gap(14);
  sheet.line("How the fare was worked out", { size: 10, bold: true });
  sheet.gap(2);

  sheet.table(
    [
      { label: "Charge", flex: 5 },
      { label: "Code", flex: 2 },
      { label: "Amount", flex: 2, align: "right" },
    ],
    content.lines.length > 0
      ? content.lines.map((line) => [line.label, line.code, money(line.amount)])
      : [["Fare as recorded on the session", "STORED", money(content.grossAmount)]],
    { zebra: true },
  );

  sheet.gap(8);
  sheet.totals([
    { label: "Taxable value", amount: taxableValue },
    {
      label: `Tax at ${content.taxPercent}%`,
      amount: content.taxAmount,
    },
    { label: "Total charged", amount: content.payableAmount, emphasis: true },
    ...(content.refundedAmount > 0
      ? [
          { label: "Refunded", amount: -content.refundedAmount },
          {
            label: "Net paid",
            amount: content.paidAmount - content.refundedAmount,
            emphasis: true,
          },
        ]
      : []),
  ]);

  sheet.gap(12);
  sheet.rule();
  sheet.gap(4);
  sheet.particulars(
    [
      ["Paid by", content.paymentMode.replace(/_/g, " ")],
      ["Paid on", content.paidAt ? formatDateTime(content.paidAt) : "Not yet settled"],
      ["Amount received", money(content.paidAmount)],
    ],
    3,
  );

  sheet.gap(16);
  sheet.paragraph(
    "This receipt is issued by the Kolkata Municipal Corporation through its appointed parking " +
      "operator. Keep it for the duration of your stay. A dispute about this fare should quote the " +
      "session code above.",
    { size: 8 },
  );

  sheet.footer([
    `Receipt ${content.receiptNumber} · session ${content.sessionCode} · issued ${formatDate(content.issuedAt)}`,
    `Amounts in INR. Times are IST. Document fingerprint ${digest.slice(0, 32)}`,
  ]);

  return sheet.save();
}
