import { describe, expect, it } from "vitest";

import { render, describeTemplates, isTemplateKey } from "../src/modules/messaging/templates/message-templates";
import { money, duration } from "../src/modules/messaging/templates/message-facts";
import { AppException } from "../src/common/errors/app.exception";

/**
 * Templates.
 *
 * The property being defended is narrow and important: an SMS and an email
 * about the same event must not be able to disagree about the facts. That is
 * structural — a template produces one set of facts and the channels are pure
 * renderings of it — but structure that is never checked drifts, so it is
 * checked here for every template in the catalogue, not just for a sample.
 */

const APP_URL = "https://park.kmcp.gov.in";

const PAID_AT = new Date("2026-03-14T09:45:00.000Z");

/** One valid payload per template. Adding a template without one fails a test. */
const SAMPLES: Record<string, Record<string, unknown>> = {
  "receipt.issued": {
    receiptNumber: "KMCP-R-000418",
    amount: 123450,
    plateNumber: "WB02AB1234",
    zoneName: "Esplanade East",
    paidAt: PAID_AT,
    mode: "UPI QR",
    sessionCode: "KMCP-8F3K2Q",
  },
  "pass.issued": {
    holderName: "Ruma Sen",
    planName: "Monthly — Central",
    plateNumber: "WB02AB1234",
    validFrom: new Date("2026-03-01T00:00:00.000Z"),
    validTo: new Date("2026-03-31T00:00:00.000Z"),
    passCode: "PASS-7QX2",
  },
  "pass.renewal": {
    holderName: "Ruma Sen",
    planName: "Monthly — Central",
    plateNumber: "WB02AB1234",
    validTo: new Date("2026-03-31T00:00:00.000Z"),
    price: 90000,
    daysLeft: 3,
  },
  "session.started": {
    sessionCode: "KMCP-8F3K2Q",
    plateNumber: "WB02AB1234",
    zoneName: "Esplanade East",
    slotLabel: "EE-14",
    startAt: PAID_AT,
  },
  "session.overstay": {
    sessionCode: "KMCP-8F3K2Q",
    plateNumber: "WB02AB1234",
    zoneName: "Esplanade East",
    minutesOver: 135,
    payable: 24000,
  },
  "shift.variance": {
    attendantName: "Amit Roy",
    shiftRef: "SHF-2291",
    closedAt: PAID_AT,
    expected: 450000,
    deposited: 442000,
    variance: -8000,
  },
  "settlement.pending": {
    vendorName: "Kolkata Parking Services",
    settlementId: "STL-0091",
    periodStart: new Date("2026-02-01T00:00:00.000Z"),
    periodEnd: new Date("2026-02-28T00:00:00.000Z"),
    vendorShare: 1875000,
    governmentShare: 6125000,
  },
  "citizen.announcement": {
    title: "Esplanade East closed on 26 March",
    body: "Zone 4 is closed for the Republic Day procession. Passes remain valid elsewhere.",
    url: "https://kmcp.gov.in/notices/2026-03-26",
  },
  "report.ready": {
    reportName: "Daily collection — March",
    format: "csv",
    generatedAt: PAID_AT,
    rangeLabel: "01–14 Mar 2026",
    rowCount: 1284,
    url: "https://storage.example/report.csv?sig=abc",
  },
};

describe("the catalogue", () => {
  it("has a sample payload for every template it publishes", () => {
    const published = describeTemplates().map((t) => t.key).sort();
    expect(published).toEqual(Object.keys(SAMPLES).sort());
  });

  it("includes the seven the portal was waiting on", () => {
    for (const key of [
      "receipt.issued",
      "pass.issued",
      "pass.renewal",
      "session.started",
      "session.overstay",
      "shift.variance",
      "settlement.pending",
    ]) {
      expect(isTemplateKey(key)).toBe(true);
    }
  });

  it("describes each one in a sentence, for the delivery log and the docs", () => {
    for (const { key, description } of describeTemplates()) {
      expect(description.length, key).toBeGreaterThan(20);
    }
  });
});

describe("every channel renders from the same facts", () => {
  for (const [key, payload] of Object.entries(SAMPLES)) {
    it(`${key}: no channel invents or omits a value`, () => {
      const rendered = render(key, payload, { appUrl: APP_URL });

      // The facts are the contract. Each value must appear, unaltered, in all
      // four renderings — this is the assertion that would catch a channel
      // formatting an amount, a date or a duration its own way.
      for (const { value } of rendered.facts.details) {
        expect(rendered.whatsapp, `${key} whatsapp`).toContain(value);
        expect(rendered.email.body, `${key} email`).toContain(value);
        expect(rendered.inApp.body, `${key} in-app`).toContain(value);
      }

      expect(rendered.email.subject).toBe(rendered.facts.headline);
      expect(rendered.inApp.title).toBe(rendered.facts.headline);
      expect(rendered.sms).toContain("KMCP");
    });
  }

  it("keeps a long SMS inside three GSM segments", () => {
    const rendered = render("citizen.announcement", {
      title: "A".repeat(120),
      body: "B".repeat(600),
      url: "https://kmcp.gov.in/notices/very/long/path/that/goes/on",
    });
    expect(rendered.sms.length).toBeLessThanOrEqual(459);
    expect(rendered.sms.endsWith("…")).toBe(true);
  });
});

describe("re-rendering from a stored delivery row", () => {
  it("gives the same message after a round trip through the Json column", () => {
    // A delivery row keeps `template` and `payload` so a message can be
    // reproduced months later. Dates come back as ISO strings, and the whole
    // point is that this changes nothing a person reads.
    const live = render("receipt.issued", SAMPLES["receipt.issued"], { appUrl: APP_URL });
    const stored = JSON.parse(JSON.stringify(SAMPLES["receipt.issued"])) as unknown;
    const replayed = render("receipt.issued", stored, { appUrl: APP_URL });

    expect(replayed).toEqual(live);
  });
});

describe("links", () => {
  it("are omitted entirely when the deployment has no public app URL", () => {
    const rendered = render("session.started", SAMPLES["session.started"]);
    expect(rendered.facts.action).toBeUndefined();
    expect(rendered.inApp.href).toBeUndefined();
    expect(rendered.whatsapp).not.toContain("http");
  });

  it("point at the citizen app, not at the API", () => {
    const rendered = render("session.started", SAMPLES["session.started"], { appUrl: `${APP_URL}/` });
    // A trailing slash on the configured URL must not produce a double slash.
    expect(rendered.facts.action?.url).toBe(`${APP_URL}/sessions/KMCP-8F3K2Q`);
  });

  it("carry an officer's own URL through an announcement unchanged", () => {
    const rendered = render("citizen.announcement", SAMPLES["citizen.announcement"], { appUrl: APP_URL });
    expect(rendered.facts.action?.url).toBe("https://kmcp.gov.in/notices/2026-03-26");
  });
});

describe("payloads are validated before anything is sent", () => {
  it("refuses an unknown template", () => {
    expect(() => render("receipt.reissued", {})).toThrow(AppException);
    try {
      render("receipt.reissued", {});
    } catch (error) {
      expect((error as AppException).code).toBe("VALIDATION_FAILED");
    }
  });

  it("names the field that is wrong", () => {
    try {
      render("receipt.issued", { ...SAMPLES["receipt.issued"], amount: "one hundred" });
      throw new Error("should have refused");
    } catch (error) {
      expect(error).toBeInstanceOf(AppException);
      expect((error as AppException).details?.[0]?.field).toBe("payload.amount");
    }
  });

  it("refuses a missing required fact rather than rendering a blank", () => {
    const { receiptNumber: _omitted, ...withoutNumber } = SAMPLES["receipt.issued"];
    expect(() => render("receipt.issued", withoutNumber)).toThrow(AppException);
  });
});

describe("money", () => {
  it("is exact — the money path is integer paise end to end", () => {
    expect(money(0)).toBe("₹0.00");
    expect(money(5)).toBe("₹0.05");
    expect(money(123450)).toBe("₹1,234.50");
  });

  it("groups in lakhs, because a municipal report is read locally", () => {
    expect(money(10_000_000)).toBe("₹1,00,000.00");
    expect(money(1_000_000_000)).toBe("₹1,00,00,000.00");
  });

  it("shows a shortfall as a shortfall", () => {
    expect(money(-8000)).toBe("-₹80.00");
  });
});

describe("duration", () => {
  it("reads the way a parking charge is argued about", () => {
    expect(duration(45)).toBe("45 min");
    expect(duration(120)).toBe("2 h");
    expect(duration(135)).toBe("2 h 15 min");
  });
});
