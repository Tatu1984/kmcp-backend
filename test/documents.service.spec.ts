import { describe, expect, it } from "vitest";

import { AppException } from "../src/common/errors/app.exception";
import { digestOf } from "../src/modules/documents/digest.util";
import { rupees, money } from "../src/modules/documents/pdf.util";
import {
  reconcileReceipt,
  type ReceiptContent,
} from "../src/modules/documents/receipt.document";
import {
  reconcileSettlement,
  type SettlementContent,
  type StatementLine,
} from "../src/modules/documents/settlement.document";

/**
 * The money on the documents.
 *
 * These are the two artefacts somebody else acts on: a citizen files the
 * receipt with their accountant, and a vendor is paid against the statement. A
 * figure that is merely plausible is worse than a missing document, because
 * nobody goes looking for the error until the quarter closes.
 *
 * So the checks below are not "does it render" — that is obvious the moment
 * anybody opens the file. They are: does the arithmetic printed on the page
 * close, and does the generator's own output always satisfy it.
 */

const RECEIPT: ReceiptContent = {
  receiptNumber: "RCPT/2026-27/000123",
  gstInvoiceNo: "GST/2026-27/00045",
  issuedAt: new Date("2026-09-01T07:10:00Z"),
  sessionCode: "KMCP-8F3K2Q",
  plateNumber: "WB02AB1234",
  vehicleType: "Car",
  zoneName: "Park Street",
  zoneCode: "PS-01",
  wardName: "63",
  startAt: new Date("2026-09-01T04:30:00Z"),
  endAt: new Date("2026-09-01T07:05:00Z"),
  durationMinutes: 155,
  // As QuoteService stores them: the lines total the gross, and a discount is a
  // negative line inside that total rather than a separate subtraction.
  lines: [
    { code: "BASE", label: "Base rate — first 60 minutes", amount: 2000 },
    { code: "INCREMENT", label: "4 × 30 minute block", amount: 4000 },
    { code: "RULE_PEAK_HOUR", label: "Peak hour (×1.25)", amount: 1500 },
    { code: "DISCOUNT", label: "Discount", amount: -500 },
  ],
  grossAmount: 7000,
  discountAmount: 500,
  penaltyAmount: 0,
  taxAmount: 1260,
  taxPercent: 18,
  payableAmount: 8260,
  paidAmount: 8260,
  refundedAmount: 0,
  paymentMode: "UPI_QR",
  paidAt: new Date("2026-09-01T07:09:00Z"),
  vendorName: "Metro Parking Pvt Ltd",
  vendorGstin: "19AABCM1234C1Z5",
};

describe("receipt arithmetic", () => {
  it("derives the taxable value by subtraction, so it can never disagree with the total", () => {
    const { taxableValue } = reconcileReceipt(RECEIPT);
    expect(taxableValue).toBe(7000);
    expect(taxableValue + RECEIPT.taxAmount).toBe(RECEIPT.payableAmount);
  });

  it("accepts a stored breakdown whose lines total the recorded gross", () => {
    const total = RECEIPT.lines.reduce((sum, line) => sum + line.amount, 0);
    expect(total).toBe(RECEIPT.grossAmount);
    expect(() => reconcileReceipt(RECEIPT)).not.toThrow();
  });

  it("refuses to issue when the fare lines do not total the recorded gross", () => {
    // The exact shape of a bug that would otherwise print a receipt claiming a
    // fare nobody was charged: a line dropped from the stored breakdown.
    const broken = { ...RECEIPT, lines: RECEIPT.lines.slice(0, 2) };
    expect(() => reconcileReceipt(broken)).toThrow(AppException);
    expect(() => reconcileReceipt(broken)).toThrow(/do not add up/i);
  });

  it("refuses to issue when gross plus tax does not equal the amount payable", () => {
    expect(() => reconcileReceipt({ ...RECEIPT, taxAmount: 1261 })).toThrow(AppException);
  });

  it("refuses to issue when more has been refunded than was ever paid", () => {
    expect(() => reconcileReceipt({ ...RECEIPT, refundedAmount: 9000 })).toThrow(AppException);
  });

  it("renders a fully refunded payment rather than refusing it", () => {
    // A full refund is an ordinary event and the receipt still has to exist:
    // it is the document the refund is evidenced against.
    const refunded = { ...RECEIPT, refundedAmount: RECEIPT.paidAmount };
    expect(() => reconcileReceipt(refunded)).not.toThrow();
  });

  it("survives a session with no stored breakdown at all", () => {
    // Sessions written before the quote engine stored its lines. The totals
    // still have to close; only the itemisation is missing.
    expect(() => reconcileReceipt({ ...RECEIPT, lines: [] })).not.toThrow();
  });
});

/**
 * Builds a settlement exactly the way SettlementsService.generateOnce builds
 * one: commission rounded per line and then totalled, vendor share equal to
 * that total, and the municipal share taken as the remainder.
 *
 * The point of duplicating the generator's arithmetic here rather than
 * importing it is that the statement check has to hold against the *rule*, not
 * against one implementation of it. If the two ever diverge, this fails.
 */
function settlementFrom(
  amounts: { amount: number; mode: string }[],
  commissionPct: number,
): SettlementContent {
  const lines: StatementLine[] = amounts.map((entry, index) => ({
    paymentId: `pay_${index}`,
    sessionCode: `KMCP-${index}`,
    plateNumber: "WB02AB1234",
    mode: entry.mode,
    paidAt: new Date("2026-09-10T05:00:00Z"),
    amount: entry.amount,
    commission: Math.round((entry.amount * commissionPct) / 100),
  }));

  const gross = lines.reduce((sum, line) => sum + line.amount, 0);
  const commission = lines.reduce((sum, line) => sum + line.commission, 0);
  const cash = lines
    .filter((line) => line.mode === "CASH")
    .reduce((sum, line) => sum + line.amount, 0);

  return {
    reference: "STL-202609-AB12",
    settlementId: "stl_1",
    status: "APPROVED",
    periodStart: new Date("2026-09-01T00:00:00Z"),
    periodEnd: new Date("2026-09-30T23:59:59Z"),
    generatedAt: new Date("2026-10-01T04:00:00Z"),
    vendorName: "Metro Parking Pvt Ltd",
    vendorGstin: "19AABCM1234C1Z5",
    commissionPct,
    bankAccountNo: "0011223344",
    bankIfsc: "SBIN0001234",
    grossCollected: gross,
    cashCollected: cash,
    digitalCollected: gross - cash,
    commissionAmount: commission,
    vendorShare: commission,
    governmentShare: gross - commission,
    approvedBy: "Rina Dasgupta",
    approvedAt: new Date("2026-10-01T03:00:00Z"),
    payoutRef: "NEFT/2026/00891",
    payoutStatus: "PAID",
    lines,
  };
}

/** Amounts chosen so per-line rounding cannot be undone by one percentage. */
const AWKWARD = [
  { amount: 4999, mode: "CASH" },
  { amount: 3333, mode: "UPI_QR" },
  { amount: 1, mode: "CASH" },
  { amount: 12345, mode: "CARD" },
  { amount: 7, mode: "CASH" },
  { amount: 99999, mode: "UPI_INTENT" },
];

describe("settlement statement reconciliation", () => {
  it("accepts what the generator produces, at an awkward commission rate", () => {
    expect(() => reconcileSettlement(settlementFrom(AWKWARD, 18))).not.toThrow();
  });

  it("holds for every commission rate the authority could set", () => {
    for (let pct = 0; pct <= 100; pct += 0.5) {
      expect(() => reconcileSettlement(settlementFrom(AWKWARD, pct))).not.toThrow();
    }
  });

  it("proves the per-line rounding really does differ from one percentage", () => {
    // If this were ever false, the check above would be vacuous — the two ways
    // of arriving at the commission would agree and there would be nothing to
    // reconcile. It is not false: at 18% these particular amounts happen to
    // coincide, which is exactly why the sweep matters and one rate does not.
    const divergent = [];
    for (let pct = 0.5; pct <= 100; pct += 0.5) {
      const statement = settlementFrom(AWKWARD, pct);
      const naive = Math.round((statement.grossCollected * pct) / 100);
      if (statement.commissionAmount !== naive) divergent.push(pct);
    }
    expect(divergent.length).toBeGreaterThan(0);
  });

  it("keeps the two shares adding back to gross exactly", () => {
    const statement = settlementFrom(AWKWARD, 18);
    expect(statement.vendorShare + statement.governmentShare).toBe(statement.grossCollected);
  });

  it("refuses a statement whose cash and digital split does not total the gross", () => {
    const statement = settlementFrom(AWKWARD, 18);
    expect(() =>
      reconcileSettlement({ ...statement, cashCollected: statement.cashCollected + 1 }),
    ).toThrow(AppException);
  });

  it("refuses a statement whose payment lines do not total the gross", () => {
    const statement = settlementFrom(AWKWARD, 18);
    // A line that was settled but never made it onto the paperwork: exactly the
    // discrepancy that costs a week of somebody's life at quarter end.
    expect(() => reconcileSettlement({ ...statement, lines: statement.lines.slice(1) })).toThrow(
      AppException,
    );
  });

  it("refuses a statement whose per-line commission does not total the recorded commission", () => {
    const statement = settlementFrom(AWKWARD, 18);
    expect(() =>
      reconcileSettlement({ ...statement, commissionAmount: statement.commissionAmount + 1 }),
    ).toThrow(AppException);
  });

  it("refuses a statement where the shares do not add back to the gross", () => {
    const statement = settlementFrom(AWKWARD, 18);
    expect(() =>
      reconcileSettlement({ ...statement, governmentShare: statement.governmentShare - 1 }),
    ).toThrow(AppException);
  });

  it("names the figures in the refusal, so somebody can act on it", () => {
    const statement = settlementFrom(AWKWARD, 18);
    try {
      reconcileSettlement({ ...statement, lines: statement.lines.slice(1) });
      expect.unreachable("should have refused");
    } catch (error) {
      const details = (error as AppException).details ?? [];
      expect(details.some((detail) => detail.field === "lines")).toBe(true);
      expect(details[0].issue).toMatch(/\d+/);
    }
  });

  it("settles an empty period as zero rather than refusing it", () => {
    expect(() => reconcileSettlement(settlementFrom([], 18))).not.toThrow();
  });
});

describe("money formatting", () => {
  it("groups in the Indian convention, not the western one", () => {
    expect(rupees(123456789)).toBe("12,34,567.89");
    expect(rupees(100000)).toBe("1,000.00");
    expect(rupees(1)).toBe("0.01");
    expect(rupees(0)).toBe("0.00");
  });

  it("keeps a negative amount readable", () => {
    expect(money(-2500)).toBe("Rs. -25.00");
  });

  it("never loses a paisa to floating point", () => {
    for (const paise of [1, 7, 99, 101, 999999, 100000007]) {
      const [whole, fraction] = rupees(paise).split(".");
      const recovered = Number(whole.replace(/,/g, "")) * 100 + Number(fraction);
      expect(recovered).toBe(paise);
    }
  });
});

describe("the content digest, which is how regeneration is decided", () => {
  it("does not depend on the order the keys were selected in", () => {
    // Two queries selecting the same columns in a different order must address
    // the same stored document, or every download would render a fresh copy.
    expect(digestOf({ a: 1, b: { c: 2, d: 3 } })).toBe(digestOf({ b: { d: 3, c: 2 }, a: 1 }));
  });

  it("changes when any figure on the document changes", () => {
    const before = digestOf(settlementFrom(AWKWARD, 18));
    const after = digestOf(settlementFrom(AWKWARD, 18.5));
    expect(after).not.toBe(before);
  });

  it("changes when a payment line is added to the period", () => {
    const before = digestOf(settlementFrom(AWKWARD, 18));
    const after = digestOf(settlementFrom([...AWKWARD, { amount: 500, mode: "CASH" }], 18));
    expect(after).not.toBe(before);
  });

  it("is stable for an unchanged record, so the stored file is reused", () => {
    expect(digestOf(settlementFrom(AWKWARD, 18))).toBe(digestOf(settlementFrom(AWKWARD, 18)));
  });

  it("treats a date as its instant rather than its object identity", () => {
    expect(digestOf({ at: new Date("2026-09-01T00:00:00Z") })).toBe(
      digestOf({ at: new Date("2026-09-01T00:00:00.000Z") }),
    );
  });
});
