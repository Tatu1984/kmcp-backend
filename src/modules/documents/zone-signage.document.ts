import * as QRCode from "qrcode";

import { Sheet, formatDate, money } from "./pdf.util";

/**
 * The tariff board.
 *
 * The odd one out in this module: the other three are records of something that
 * happened, and this is a notice about what will happen. It is read at arm's
 * length by somebody standing in the rain deciding whether to park, so it is
 * laid out for a pole rather than for a filing cabinet — one sheet, large type,
 * the rates in a grid, and a QR code big enough to scan from a car window.
 *
 * It carries no personal data at all, which is why its read rule is the zone's
 * own `zone.read` rather than a document grant.
 */
export interface SignageTariff {
  vehicleType: string;
  baseAmount: number;
  baseMinutes: number;
  incrementAmount: number;
  incrementMinutes: number;
  dailyCapAmount: number | null;
  gracePeriodMin: number;
  overstayPenalty: number | null;
  taxPercent: number;
  effectiveFrom: Date;
}

export interface ZoneSignageContent {
  zoneId: string;
  zoneName: string;
  zoneCode: string;
  wardName: string | null;
  streetName: string | null;
  capacity: number;
  openTime: string;
  closeTime: string;
  status: string;
  vendorName: string | null;
  /** Encoded into the QR — what a phone camera opens. */
  qrPayload: string;
  tariffs: SignageTariff[];
  generatedAt: Date;
}

/** "Rs. 20.00 for the first 60 min, then Rs. 10.00 per 30 min". */
function rateSentence(tariff: SignageTariff): string {
  const base = `${money(tariff.baseAmount)} for the first ${tariff.baseMinutes} min`;
  const increment = `then ${money(tariff.incrementAmount)} per ${tariff.incrementMinutes} min`;
  return `${base}, ${increment}`;
}

export async function renderZoneSignage(
  content: ZoneSignageContent,
  digest: string,
): Promise<Uint8Array> {
  const sheet = await Sheet.create(
    `Parking tariff board — ${content.zoneName}`,
    `Zone ${content.zoneCode}`,
  );

  sheet.line("KOLKATA MUNICIPAL CORPORATION", { size: 10, bold: true, color: Sheet.muted });
  sheet.gap(4);
  sheet.line("PAID PARKING", { size: 30, bold: true });
  sheet.line(content.zoneName, { size: 20, bold: true });
  sheet.line(
    [content.streetName, content.wardName ? `Ward ${content.wardName}` : null]
      .filter(Boolean)
      .join(" · ") || " ",
    { size: 11, color: Sheet.muted },
  );
  sheet.rule();

  sheet.gap(4);
  sheet.particulars(
    [
      ["Zone code", content.zoneCode],
      ["Hours", `${content.openTime} to ${content.closeTime}`],
      ["Bays", String(content.capacity)],
    ],
    3,
  );

  sheet.gap(18);
  sheet.line("Tariff", { size: 14, bold: true });
  sheet.gap(4);

  if (content.tariffs.length === 0) {
    sheet.paragraph(
      "No tariff is published for this zone. Parking here is not chargeable until one is.",
      { size: 11 },
    );
  } else {
    sheet.table(
      [
        { label: "Vehicle", flex: 3 },
        { label: "Rate", flex: 6 },
        { label: "Free for", flex: 2, align: "right" },
        { label: "Daily max", flex: 2, align: "right" },
      ],
      content.tariffs.map((tariff) => [
        tariff.vehicleType.replace(/_/g, " "),
        rateSentence(tariff),
        tariff.gracePeriodMin > 0 ? `${tariff.gracePeriodMin} min` : "-",
        tariff.dailyCapAmount === null ? "-" : money(tariff.dailyCapAmount),
      ]),
      { zebra: true },
    );

    const taxed = content.tariffs.filter((tariff) => tariff.taxPercent > 0);
    const penalties = content.tariffs.filter((tariff) => tariff.overstayPenalty !== null);

    sheet.gap(8);
    if (taxed.length > 0) {
      sheet.paragraph(
        `All rates are exclusive of tax. Tax at ${taxed[0].taxPercent}% is added and shown separately on your receipt.`,
        { size: 9 },
      );
    }
    if (penalties.length > 0) {
      sheet.paragraph(
        `Overstaying attracts a penalty of up to ${money(
          Math.max(...penalties.map((tariff) => tariff.overstayPenalty ?? 0)),
        )}.`,
        { size: 9 },
      );
    }
    sheet.paragraph(
      `Rates in force from ${formatDate(
        new Date(Math.max(...content.tariffs.map((tariff) => tariff.effectiveFrom.getTime()))),
      )}.`,
      { size: 9 },
    );
  }

  // The QR sits in a panel of its own at the foot of the sheet, at a fixed
  // position rather than after the cursor: it is the thing a driver looks for,
  // so it must not drift up and down the page as the tariff table grows.
  const panelHeight = 168;
  const panelY = 96;
  sheet.reserveBelow(panelY + panelHeight + 24);
  sheet.box(48, panelY, sheet.contentWidth, panelHeight);

  const matrix = QRCode.create(content.qrPayload, { errorCorrectionLevel: "M" }).modules;
  const side = 128;
  sheet.qr(
    { size: matrix.size, data: matrix.data },
    48 + sheet.contentWidth - side - 20,
    panelY + (panelHeight - side) / 2,
    side,
  );

  sheet.at("SCAN TO PAY", 68, panelY + panelHeight - 34, { size: 16, bold: true });
  sheet.at("Start and end your parking session from your phone.", 68, panelY + panelHeight - 54, {
    size: 10,
  });
  sheet.at("No app? Ask the attendant on duty for a paper receipt.", 68, panelY + panelHeight - 70, {
    size: 10,
  });
  sheet.at(
    content.vendorName ? `Operated by ${content.vendorName}` : "Operated by the Corporation",
    68,
    panelY + 26,
    { size: 9, color: Sheet.muted },
  );
  sheet.at(`Zone ${content.zoneCode}`, 68, panelY + 12, { size: 9, color: Sheet.muted });

  sheet.footer([
    `Tariff board for ${content.zoneName} (${content.zoneCode}) · generated ${formatDate(content.generatedAt)}`,
    `Amounts in INR (Rs.). Rates shown are per the published tariff at the time of printing. Fingerprint ${digest.slice(0, 32)}`,
  ]);

  return sheet.save();
}
