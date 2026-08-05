import { describe, expect, it, vi } from "vitest";
import { DayType, SlotType, TariffRuleType } from "@prisma/client";
import { QuoteService } from "../src/modules/tariffs/quote.service";

/**
 * Golden matrix for the fare engine. Every pricing dimension in the scope of
 * work gets a case, because this is the one piece of code where being wrong
 * means overcharging a citizen or short-changing the municipality.
 *
 * Amounts are paise. ₹20.00 = 2000.
 */

const ZONE = "zn_test";

function tariff(overrides: Record<string, unknown> = {}, rules: unknown[] = []) {
  return {
    id: "trf_1",
    name: "City Standard — Car",
    zoneId: null,
    vehicleTypeId: SlotType.CAR,
    baseAmount: 2000, // ₹20 for the first hour
    baseMinutes: 60,
    incrementAmount: 1500, // ₹15 per hour after that
    incrementMinutes: 60,
    dailyCapAmount: 15000, // ₹150
    gracePeriodMin: 10,
    overstayPenalty: 5000, // ₹50
    taxPercent: 18,
    effectiveFrom: new Date("2026-01-01T00:00:00Z"),
    effectiveTo: null,
    priority: 1,
    isPublished: true,
    rules,
    ...overrides,
  };
}

function makeService(t: ReturnType<typeof tariff>, extras: Record<string, unknown> = {}) {
  const prisma = {
    tariff: { findMany: vi.fn().mockResolvedValue([t]) },
    holiday: { findMany: vi.fn().mockResolvedValue(extras.holidays ?? []) },
    pass: { findFirst: vi.fn().mockResolvedValue(extras.pass ?? null) },
    discount: { findFirst: vi.fn().mockResolvedValue(extras.discount ?? null) },
  };
  return new QuoteService(prisma as never);
}

const at = (iso: string) => new Date(iso);
const minutesLater = (start: Date, minutes: number) => new Date(start.getTime() + minutes * 60_000);

describe("QuoteService — base rate and blocks", () => {
  it("charges nothing inside the grace period", async () => {
    const svc = makeService(tariff());
    const start = at("2026-08-05T10:00:00Z");
    const q = await svc.quote({
      zoneId: ZONE,
      vehicleType: SlotType.CAR,
      startAt: start,
      endAt: minutesLater(start, 8),
    });

    expect(q.payableAmount).toBe(0);
    expect(q.chargeableMinutes).toBe(0);
    expect(q.lines[0].code).toBe("WITHIN_GRACE");
  });

  it("charges the base rate alone within the first block", async () => {
    const svc = makeService(tariff());
    const start = at("2026-08-05T10:00:00Z");
    const q = await svc.quote({
      zoneId: ZONE,
      vehicleType: SlotType.CAR,
      startAt: start,
      endAt: minutesLater(start, 45),
    });

    expect(q.grossAmount).toBe(2000);
    expect(q.taxAmount).toBe(360); // 18% of ₹20
    expect(q.payableAmount).toBe(2360);
  });

  it("adds one increment block once the base window is exceeded", async () => {
    const svc = makeService(tariff());
    const start = at("2026-08-05T10:00:00Z");
    // 100 minutes − 10 grace = 90 chargeable → base 60 + one 60-minute block
    const q = await svc.quote({
      zoneId: ZONE,
      vehicleType: SlotType.CAR,
      startAt: start,
      endAt: minutesLater(start, 100),
    });

    expect(q.grossAmount).toBe(3500); // 2000 + 1500
    expect(q.payableAmount).toBe(4130);
  });

  it("rounds a part-used block up to a whole block", async () => {
    const svc = makeService(tariff());
    const start = at("2026-08-05T10:00:00Z");
    // 71 minutes − 10 grace = 61 chargeable → 1 minute into the second block
    const q = await svc.quote({
      zoneId: ZONE,
      vehicleType: SlotType.CAR,
      startAt: start,
      endAt: minutesLater(start, 71),
    });

    expect(q.grossAmount).toBe(3500);
  });
});

describe("QuoteService — rule modifiers", () => {
  const peakRule = {
    id: "r1",
    type: TariffRuleType.PEAK_HOUR,
    dayType: DayType.WEEKDAY,
    timeFrom: "09:00",
    timeTo: "12:00",
    multiplier: 1.5,
    flatAmount: null,
    priority: 10,
    isActive: true,
  };

  it("applies a peak multiplier inside the window on a weekday", async () => {
    const svc = makeService(tariff({}, [peakRule]));
    const start = at("2026-08-05T10:00:00Z"); // Wednesday, inside 09:00–12:00
    const q = await svc.quote({
      zoneId: ZONE,
      vehicleType: SlotType.CAR,
      startAt: start,
      endAt: minutesLater(start, 45),
    });

    expect(q.grossAmount).toBe(3000); // 2000 × 1.5
    expect(q.lines.some((l) => l.code === "RULE_PEAK_HOUR")).toBe(true);
  });

  it("does not apply a peak multiplier outside the window", async () => {
    const svc = makeService(tariff({}, [peakRule]));
    const start = at("2026-08-05T14:00:00Z"); // Wednesday, after the window
    const q = await svc.quote({
      zoneId: ZONE,
      vehicleType: SlotType.CAR,
      startAt: start,
      endAt: minutesLater(start, 45),
    });

    expect(q.grossAmount).toBe(2000);
  });

  it("does not apply a weekday rule at the weekend", async () => {
    const svc = makeService(tariff({}, [peakRule]));
    const start = at("2026-08-08T10:00:00Z"); // Saturday
    const q = await svc.quote({
      zoneId: ZONE,
      vehicleType: SlotType.CAR,
      startAt: start,
      endAt: minutesLater(start, 45),
    });

    expect(q.grossAmount).toBe(2000);
  });

  it("handles a night window that wraps past midnight", async () => {
    const nightRule = {
      id: "r2",
      type: TariffRuleType.NIGHT,
      dayType: DayType.ALL,
      timeFrom: "22:00",
      timeTo: "06:00",
      multiplier: 0.6,
      flatAmount: null,
      priority: 5,
      isActive: true,
    };
    const svc = makeService(tariff({}, [nightRule]));
    const start = at("2026-08-05T23:30:00Z");
    const q = await svc.quote({
      zoneId: ZONE,
      vehicleType: SlotType.CAR,
      startAt: start,
      endAt: minutesLater(start, 45),
    });

    expect(q.grossAmount).toBe(1200); // 2000 × 0.6 — a concession, not a surcharge
  });

  it("compounds peak and weekend in priority order", async () => {
    const weekendPeak = {
      id: "r3",
      type: TariffRuleType.PEAK_HOUR,
      dayType: DayType.ALL,
      timeFrom: "09:00",
      timeTo: "12:00",
      multiplier: 1.5,
      flatAmount: null,
      priority: 10,
      isActive: true,
    };
    const weekend = {
      id: "r4",
      type: TariffRuleType.WEEKEND,
      dayType: DayType.WEEKEND,
      timeFrom: null,
      timeTo: null,
      multiplier: 1.25,
      flatAmount: null,
      priority: 5,
      isActive: true,
    };
    const svc = makeService(tariff({}, [weekendPeak, weekend]));
    const start = at("2026-08-08T10:00:00Z"); // Saturday inside the peak window
    const q = await svc.quote({
      zoneId: ZONE,
      vehicleType: SlotType.CAR,
      startAt: start,
      endAt: minutesLater(start, 45),
    });

    // 2000 → ×1.5 = 3000 → ×1.25 = 3750
    expect(q.grossAmount).toBe(3750);
  });

  it("applies a holiday rule only on a holiday", async () => {
    const holidayRule = {
      id: "r5",
      type: TariffRuleType.HOLIDAY,
      dayType: DayType.HOLIDAY,
      timeFrom: null,
      timeTo: null,
      multiplier: 1.4,
      flatAmount: null,
      priority: 20,
      isActive: true,
    };
    const holiday = { id: "h1", date: at("2026-08-15T00:00:00Z"), name: "Independence Day", zoneIds: [] };

    const onHoliday = makeService(tariff({}, [holidayRule]), { holidays: [holiday] });
    const start = at("2026-08-15T10:00:00Z");
    const q1 = await onHoliday.quote({
      zoneId: ZONE,
      vehicleType: SlotType.CAR,
      startAt: start,
      endAt: minutesLater(start, 45),
    });
    expect(q1.grossAmount).toBe(2800); // 2000 × 1.4

    const normalDay = makeService(tariff({}, [holidayRule]), { holidays: [] });
    const q2 = await normalDay.quote({
      zoneId: ZONE,
      vehicleType: SlotType.CAR,
      startAt: at("2026-08-05T10:00:00Z"),
      endAt: at("2026-08-05T10:45:00Z"),
    });
    expect(q2.grossAmount).toBe(2000);
  });

  it("ignores an inactive rule", async () => {
    const svc = makeService(tariff({}, [{ ...peakRule, isActive: false }]));
    const start = at("2026-08-05T10:00:00Z");
    const q = await svc.quote({
      zoneId: ZONE,
      vehicleType: SlotType.CAR,
      startAt: start,
      endAt: minutesLater(start, 45),
    });
    expect(q.grossAmount).toBe(2000);
  });
});

describe("QuoteService — caps, penalties, discounts and passes", () => {
  it("never charges more than the daily cap", async () => {
    const svc = makeService(tariff());
    const start = at("2026-08-05T00:00:00Z");
    const q = await svc.quote({
      zoneId: ZONE,
      vehicleType: SlotType.CAR,
      startAt: start,
      endAt: minutesLater(start, 24 * 60),
    });

    expect(q.grossAmount).toBe(15000);
    expect(q.cappedByDailyLimit).toBe(true);
    expect(q.payableAmount).toBe(17700); // cap + 18%
  });

  it("adds the overstay penalty past the threshold", async () => {
    const svc = makeService(tariff());
    const start = at("2026-08-05T10:00:00Z");
    const q = await svc.quote({
      zoneId: ZONE,
      vehicleType: SlotType.CAR,
      startAt: start,
      endAt: minutesLater(start, 400),
      overstayAfterMinutes: 360,
    });

    expect(q.penaltyAmount).toBe(5000);
    expect(q.lines.some((l) => l.code === "OVERSTAY")).toBe(true);
  });

  it("does not add a penalty below the threshold", async () => {
    const svc = makeService(tariff());
    const start = at("2026-08-05T10:00:00Z");
    const q = await svc.quote({
      zoneId: ZONE,
      vehicleType: SlotType.CAR,
      startAt: start,
      endAt: minutesLater(start, 120),
      overstayAfterMinutes: 360,
    });

    expect(q.penaltyAmount).toBe(0);
  });

  it("applies a percentage discount", async () => {
    const discount = {
      id: "d1",
      percentOff: 25,
      flatOff: null,
      maxUses: null,
      usedCount: 0,
      code: null,
    };
    const svc = makeService(tariff(), { discount });
    const start = at("2026-08-05T10:00:00Z");
    const q = await svc.quote({
      zoneId: ZONE,
      vehicleType: SlotType.CAR,
      startAt: start,
      endAt: minutesLater(start, 45),
    });

    expect(q.discountAmount).toBe(500); // 25% of 2000
    expect(q.grossAmount).toBe(1500);
  });

  it("ignores a discount that has hit its usage limit", async () => {
    const discount = {
      id: "d2",
      percentOff: 50,
      flatOff: null,
      maxUses: 100,
      usedCount: 100,
      code: null,
    };
    const svc = makeService(tariff(), { discount });
    const start = at("2026-08-05T10:00:00Z");
    const q = await svc.quote({
      zoneId: ZONE,
      vehicleType: SlotType.CAR,
      startAt: start,
      endAt: minutesLater(start, 45),
    });

    expect(q.discountAmount).toBe(0);
    expect(q.grossAmount).toBe(2000);
  });

  it("waives the charge for a valid pass but still charges the penalty", async () => {
    const pass = {
      id: "pss_1",
      plan: { zoneIds: [], vehicleTypeId: SlotType.CAR },
    };
    const svc = makeService(tariff(), { pass });
    const start = at("2026-08-05T10:00:00Z");
    const q = await svc.quote({
      zoneId: ZONE,
      vehicleType: SlotType.CAR,
      startAt: start,
      endAt: minutesLater(start, 400),
      overstayAfterMinutes: 360,
      vehicleId: "veh_1",
    });

    expect(q.waivedByPass).toBe(true);
    expect(q.grossAmount).toBe(5000); // only the penalty survives
    expect(q.passId).toBe("pss_1");
  });

  it("ignores a pass issued for a different zone", async () => {
    const pass = {
      id: "pss_2",
      plan: { zoneIds: ["zn_other"], vehicleTypeId: SlotType.CAR },
    };
    const svc = makeService(tariff(), { pass });
    const start = at("2026-08-05T10:00:00Z");
    const q = await svc.quote({
      zoneId: ZONE,
      vehicleType: SlotType.CAR,
      startAt: start,
      endAt: minutesLater(start, 45),
      vehicleId: "veh_1",
    });

    expect(q.waivedByPass).toBe(false);
    expect(q.grossAmount).toBe(2000);
  });

  it("ignores a pass issued for a different vehicle type", async () => {
    const pass = {
      id: "pss_3",
      plan: { zoneIds: [], vehicleTypeId: SlotType.TWO_WHEELER },
    };
    const svc = makeService(tariff(), { pass });
    const start = at("2026-08-05T10:00:00Z");
    const q = await svc.quote({
      zoneId: ZONE,
      vehicleType: SlotType.CAR,
      startAt: start,
      endAt: minutesLater(start, 45),
      vehicleId: "veh_1",
    });

    expect(q.waivedByPass).toBe(false);
  });
});

describe("QuoteService — tariff resolution", () => {
  it("prefers a zone-specific tariff over a city-wide one", async () => {
    const cityWide = tariff({ id: "trf_city", zoneId: null, baseAmount: 2000 });
    const zoneRate = tariff({ id: "trf_zone", zoneId: ZONE, baseAmount: 3000 });

    const prisma = {
      tariff: { findMany: vi.fn().mockResolvedValue([cityWide, zoneRate]) },
      holiday: { findMany: vi.fn().mockResolvedValue([]) },
      pass: { findFirst: vi.fn().mockResolvedValue(null) },
      discount: { findFirst: vi.fn().mockResolvedValue(null) },
    };
    const svc = new QuoteService(prisma as never);

    const resolved = await svc.resolveTariff(ZONE, SlotType.CAR, at("2026-08-05T10:00:00Z"));
    expect(resolved.id).toBe("trf_zone");
  });

  it("refuses to price when no published tariff covers the zone", async () => {
    const prisma = {
      tariff: { findMany: vi.fn().mockResolvedValue([]) },
      holiday: { findMany: vi.fn().mockResolvedValue([]) },
      pass: { findFirst: vi.fn().mockResolvedValue(null) },
      discount: { findFirst: vi.fn().mockResolvedValue(null) },
    };
    const svc = new QuoteService(prisma as never);

    await expect(
      svc.resolveTariff(ZONE, SlotType.CAR, at("2026-08-05T10:00:00Z")),
    ).rejects.toThrow(/NO_APPLICABLE_TARIFF|tariff/i);
  });

  it("every amount it returns is an integer number of paise", async () => {
    const svc = makeService(tariff({}, [
      {
        id: "r9",
        type: TariffRuleType.PEAK_HOUR,
        dayType: DayType.ALL,
        timeFrom: null,
        timeTo: null,
        multiplier: 1.333,
        flatAmount: null,
        priority: 1,
        isActive: true,
      },
    ]));
    const start = at("2026-08-05T10:00:00Z");
    const q = await svc.quote({
      zoneId: ZONE,
      vehicleType: SlotType.CAR,
      startAt: start,
      endAt: minutesLater(start, 200),
    });

    for (const line of q.lines) expect(Number.isInteger(line.amount)).toBe(true);
    expect(Number.isInteger(q.grossAmount)).toBe(true);
    expect(Number.isInteger(q.taxAmount)).toBe(true);
    expect(Number.isInteger(q.payableAmount)).toBe(true);
    expect(q.payableAmount).toBe(q.grossAmount + q.taxAmount);
  });
});
