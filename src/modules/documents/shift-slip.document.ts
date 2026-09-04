import { Sheet, formatDate, formatDateTime, formatDuration, money } from "./pdf.util";

/**
 * The cash-handover slip.
 *
 * Two people sign this: the attendant who counted the money and whoever
 * received it. That is the reason the variance is stated in words as well as
 * figures and the reason both signature blocks are printed even when the shift
 * has already been verified in the system — the paper is what gets filed.
 */
export interface ShiftSlipContent {
  shiftId: string;
  reference: string;
  status: string;
  generatedAt: Date;

  attendantName: string;
  employeeCode: string;
  attendantPhone: string | null;
  vendorName: string;
  zoneName: string | null;
  zoneCode: string | null;

  startAt: Date;
  endAt: Date | null;
  durationMinutes: number | null;

  sessionsCount: number;
  cashExpected: number;
  cashDeposited: number | null;
  digitalTotal: number;
  varianceAmount: number | null;

  verifiedBy: string | null;
  verifiedAt: Date | null;
}

/** How a gap in the cash reads to somebody who has to act on it. */
function varianceNote(variance: number | null): string {
  if (variance === null) return "The shift has not been closed, so nothing has been declared yet.";
  if (variance === 0) return "The cash handed in matches what the system recorded. No variance.";
  return variance > 0
    ? `A surplus of ${money(variance)} was handed in over what the system recorded. This needs explaining before the shift is verified.`
    : `A shortfall of ${money(Math.abs(variance))} against what the system recorded. This needs explaining before the shift is verified.`;
}

export async function renderShiftSlip(
  content: ShiftSlipContent,
  digest: string,
): Promise<Uint8Array> {
  const sheet = await Sheet.create(
    `Shift slip ${content.reference}`,
    `${content.attendantName} · ${formatDate(content.startAt)}`,
  );

  sheet.masthead(
    "Shift cash slip",
    `${content.attendantName} · ${content.zoneName ?? "No zone recorded"}`,
    content.reference,
  );

  sheet.particulars([
    ["Attendant", content.attendantName],
    ["Employee code", content.employeeCode],
    ["Mobile", content.attendantPhone ?? "-"],
    ["Employer", content.vendorName],
    ["Zone", content.zoneName ? `${content.zoneName} · ${content.zoneCode ?? ""}`.trim() : "-"],
    ["Shift status", content.status.replace(/_/g, " ")],
    ["Opened", formatDateTime(content.startAt)],
    ["Closed", content.endAt ? formatDateTime(content.endAt) : "Still open"],
  ]);

  sheet.gap(10);
  sheet.particulars(
    [
      ["Time on shift", formatDuration(content.durationMinutes)],
      ["Sessions handled", String(content.sessionsCount)],
      ["Digital collected", money(content.digitalTotal)],
    ],
    3,
  );

  sheet.gap(16);
  sheet.line("Cash", { size: 10, bold: true });
  sheet.gap(2);
  sheet.table(
    [
      { label: "Item", flex: 6 },
      { label: "Amount", flex: 2, align: "right" },
    ],
    [
      ["Cash the system recorded for this shift", money(content.cashExpected)],
      [
        "Cash the attendant declared at close",
        content.cashDeposited === null ? "Not declared" : money(content.cashDeposited),
      ],
      [
        "Variance (declared less recorded)",
        content.varianceAmount === null ? "-" : money(content.varianceAmount),
      ],
    ],
  );

  sheet.gap(8);
  sheet.paragraph(varianceNote(content.varianceAmount), { size: 9, bold: true });

  sheet.gap(6);
  sheet.paragraph(
    "Digital takings are shown for completeness only. They never pass through the attendant's " +
      "hands, so they are not part of the handover and are excluded from the variance.",
    { size: 8 },
  );

  sheet.gap(20);
  sheet.line("Handover", { size: 10, bold: true });
  sheet.gap(6);

  // Two signature blocks, side by side. Separating who counted from who
  // received is the control the whole shift model exists for; printing one
  // line for both would quietly undo it on paper.
  const half = sheet.contentWidth / 2 - 12;
  sheet.ensure(96);
  const top = sheet.cursor;
  const right = 48 + half + 24;

  sheet.at("Counted and handed over by", 48, top - 12, { size: 7.5, bold: true, color: Sheet.muted });
  sheet.at(content.attendantName, 48, top - 26, { size: 9.5 });
  sheet.hairline(48, top - 62, half);
  sheet.at("Signature and date", 48, top - 74, { size: 7.5, color: Sheet.muted });

  sheet.at("Received and verified by", right, top - 12, { size: 7.5, bold: true, color: Sheet.muted });
  sheet.at(content.verifiedBy ?? "Name and designation", right, top - 26, {
    size: 9.5,
    color: content.verifiedBy ? undefined : Sheet.muted,
  });
  sheet.hairline(right, top - 62, half);
  sheet.at("Signature and date", right, top - 74, { size: 7.5, color: Sheet.muted });

  sheet.gap(86);

  if (content.verifiedAt) {
    sheet.gap(8);
    sheet.line(
      `Recorded as verified in the system on ${formatDateTime(content.verifiedAt)}.`,
      { size: 8 },
    );
  }

  sheet.footer([
    `${content.reference} · ${content.attendantName} (${content.employeeCode}) · ${formatDate(content.startAt)}`,
    `Amounts in INR. Times are IST. Generated ${formatDateTime(content.generatedAt)}. Document fingerprint ${digest.slice(0, 32)}`,
  ]);

  return sheet.save();
}
