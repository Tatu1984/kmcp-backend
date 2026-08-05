import { Injectable } from "@nestjs/common";
import { DayType, Prisma, SlotType, TariffRuleType } from "@prisma/client";

import { PrismaService } from "@/prisma/prisma.service";
import { AppException } from "@/common/errors/app.exception";
import { addPaise, clampToCap, taxOn, type Paise } from "@/common/utils/money.util";

export interface QuoteLine {
  label: string;
  code: string;
  amount: Paise;
}

export interface Quote {
  tariffId: string;
  tariffName: string;
  tariffVersion: number;
  durationMinutes: number;
  chargeableMinutes: number;
  gracePeriodMin: number;
  lines: QuoteLine[];
  grossAmount: Paise;
  discountAmount: Paise;
  penaltyAmount: Paise;
  taxAmount: Paise;
  taxPercent: number;
  payableAmount: Paise;
  cappedByDailyLimit: boolean;
  waivedByPass: boolean;
  passId?: string;
}

export interface QuoteInput {
  zoneId: string;
  vehicleType: SlotType;
  startAt: Date;
  endAt: Date;
  /** Overstay penalty applies past this many minutes. */
  overstayAfterMinutes?: number;
  vehicleId?: string;
  userId?: string;
  discountCode?: string;
}

type TariffWithRules = Prisma.TariffGetPayload<{ include: { rules: true } }>;

/**
 * The single authority on what a parking session costs.
 *
 * Nothing else in this codebase — and nothing on any device — computes a fare.
 * The attendant app, the citizen app and the portal all call this, which is why
 * a tariff change takes effect everywhere on the next request with no app
 * release and no risk of two clients disagreeing about the price.
 */
@Injectable()
export class QuoteService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Zone-specific tariffs beat city-wide ones; among equals the highest
   * priority wins, then the most recently effective. Only published versions
   * that were live at `at` are considered, so a historic session re-prices
   * exactly as it was charged.
   */
  async resolveTariff(zoneId: string, vehicleType: SlotType, at: Date): Promise<TariffWithRules> {
    const candidates = await this.prisma.tariff.findMany({
      where: {
        vehicleTypeId: vehicleType,
        isPublished: true,
        effectiveFrom: { lte: at },
        OR: [{ effectiveTo: null }, { effectiveTo: { gte: at } }],
        AND: [{ OR: [{ zoneId }, { zoneId: null }] }],
      },
      include: { rules: { where: { isActive: true } } },
    });

    if (candidates.length === 0) throw new AppException("NO_APPLICABLE_TARIFF");

    candidates.sort((a, b) => {
      const zoneRank = Number(Boolean(b.zoneId)) - Number(Boolean(a.zoneId));
      if (zoneRank !== 0) return zoneRank;
      if (b.priority !== a.priority) return b.priority - a.priority;
      return b.effectiveFrom.getTime() - a.effectiveFrom.getTime();
    });

    return candidates[0];
  }

  async quote(input: QuoteInput): Promise<Quote> {
    const tariff = await this.resolveTariff(input.zoneId, input.vehicleType, input.startAt);

    const durationMinutes = Math.max(
      0,
      Math.ceil((input.endAt.getTime() - input.startAt.getTime()) / 60_000),
    );

    const pass = await this.findValidPass(input, tariff.id);
    const lines: QuoteLine[] = [];

    const chargeableMinutes = Math.max(0, durationMinutes - tariff.gracePeriodMin);
    if (chargeableMinutes === 0) {
      return this.emptyQuote(tariff, durationMinutes, "WITHIN_GRACE", "Within the grace period");
    }

    // ---- base + increment blocks
    lines.push({
      code: "BASE",
      label: `Base rate — first ${tariff.baseMinutes} minutes`,
      amount: tariff.baseAmount,
    });

    const extraMinutes = Math.max(0, chargeableMinutes - tariff.baseMinutes);
    const blocks = Math.ceil(extraMinutes / tariff.incrementMinutes);
    if (blocks > 0) {
      lines.push({
        code: "INCREMENT",
        label: `${blocks} × ${tariff.incrementMinutes} minute block`,
        amount: blocks * tariff.incrementAmount,
      });
    }

    let subtotal = addPaise(...lines.map((l) => l.amount));

    // ---- rule modifiers, applied in priority order and compounding
    const applicable = await this.applicableRules(tariff, input.startAt, input.zoneId);
    for (const rule of applicable) {
      if (rule.flatAmount) {
        lines.push({
          code: `RULE_${rule.type}`,
          label: this.ruleLabel(rule.type, null, rule.flatAmount),
          amount: rule.flatAmount,
        });
        subtotal += rule.flatAmount;
        continue;
      }
      if (rule.multiplier) {
        const multiplier = Number(rule.multiplier);
        const delta = Math.round(subtotal * multiplier) - subtotal;
        if (delta !== 0) {
          lines.push({
            code: `RULE_${rule.type}`,
            label: this.ruleLabel(rule.type, multiplier, null),
            amount: delta,
          });
          subtotal += delta;
        }
      }
    }

    // ---- daily cap, before discounts and tax
    let cappedByDailyLimit = false;
    if (tariff.dailyCapAmount !== null && subtotal > tariff.dailyCapAmount) {
      const delta = tariff.dailyCapAmount - subtotal;
      lines.push({ code: "DAILY_CAP", label: "Daily maximum applied", amount: delta });
      subtotal = tariff.dailyCapAmount;
      cappedByDailyLimit = true;
    }

    // ---- overstay penalty
    let penaltyAmount = 0;
    const overstayAfter = input.overstayAfterMinutes;
    if (overstayAfter && durationMinutes > overstayAfter && tariff.overstayPenalty) {
      penaltyAmount = tariff.overstayPenalty;
      lines.push({ code: "OVERSTAY", label: "Overstay penalty", amount: penaltyAmount });
      subtotal += penaltyAmount;
    }

    // ---- discount
    const discountAmount = await this.resolveDiscount(input, subtotal);
    if (discountAmount > 0) {
      lines.push({ code: "DISCOUNT", label: "Discount", amount: -discountAmount });
      subtotal -= discountAmount;
    }

    // ---- a valid pass waives the charge inside its scope, but never the penalty
    let waivedByPass = false;
    if (pass) {
      const waived = subtotal - penaltyAmount;
      if (waived > 0) {
        lines.push({ code: "PASS", label: "Monthly pass — charge waived", amount: -waived });
        subtotal -= waived;
      }
      waivedByPass = true;
    }

    const grossAmount = Math.max(0, subtotal);
    const taxPercent = Number(tariff.taxPercent);
    const taxAmount = taxOn(grossAmount, taxPercent);

    return {
      tariffId: tariff.id,
      tariffName: tariff.name,
      tariffVersion: tariff.priority,
      durationMinutes,
      chargeableMinutes,
      gracePeriodMin: tariff.gracePeriodMin,
      lines,
      grossAmount,
      discountAmount,
      penaltyAmount,
      taxAmount,
      taxPercent,
      payableAmount: grossAmount + taxAmount,
      cappedByDailyLimit,
      waivedByPass,
      passId: pass?.id,
    };
  }

  private emptyQuote(
    tariff: TariffWithRules,
    durationMinutes: number,
    code: string,
    label: string,
  ): Quote {
    return {
      tariffId: tariff.id,
      tariffName: tariff.name,
      tariffVersion: tariff.priority,
      durationMinutes,
      chargeableMinutes: 0,
      gracePeriodMin: tariff.gracePeriodMin,
      lines: [{ code, label, amount: 0 }],
      grossAmount: 0,
      discountAmount: 0,
      penaltyAmount: 0,
      taxAmount: 0,
      taxPercent: Number(tariff.taxPercent),
      payableAmount: 0,
      cappedByDailyLimit: false,
      waivedByPass: false,
    };
  }

  private async applicableRules(tariff: TariffWithRules, at: Date, zoneId: string) {
    const holiday = await this.findHoliday(at, zoneId);
    const dayType = this.dayTypeFor(at, Boolean(holiday));

    const matching = tariff.rules.filter((rule) => {
      if (!rule.isActive) return false;
      if (rule.dayType !== DayType.ALL && rule.dayType !== dayType) return false;
      if (rule.type === TariffRuleType.HOLIDAY && !holiday) return false;
      if (rule.timeFrom && rule.timeTo && !this.withinWindow(at, rule.timeFrom, rule.timeTo)) {
        return false;
      }
      return true;
    });

    return matching.sort((a, b) => b.priority - a.priority);
  }

  private dayTypeFor(at: Date, isHoliday: boolean): DayType {
    if (isHoliday) return DayType.HOLIDAY;
    const day = at.getUTCDay();
    return day === 0 || day === 6 ? DayType.WEEKEND : DayType.WEEKDAY;
  }

  /** Handles windows that wrap past midnight, such as a 22:00–06:00 night rate. */
  private withinWindow(at: Date, from: string, to: string): boolean {
    const minutes = at.getUTCHours() * 60 + at.getUTCMinutes();
    const [fh, fm] = from.split(":").map(Number);
    const [th, tm] = to.split(":").map(Number);
    const start = fh * 60 + fm;
    const end = th * 60 + tm;
    return start <= end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
  }

  private async findHoliday(at: Date, zoneId: string) {
    const date = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
    const holidays = await this.prisma.holiday.findMany({ where: { date } });
    return holidays.find((h) => h.zoneIds.length === 0 || h.zoneIds.includes(zoneId)) ?? null;
  }

  private async findValidPass(input: QuoteInput, _tariffId: string) {
    if (!input.vehicleId && !input.userId) return null;

    const pass = await this.prisma.pass.findFirst({
      where: {
        status: "ACTIVE",
        validFrom: { lte: input.startAt },
        validTo: { gte: input.startAt },
        ...(input.vehicleId ? { vehicleId: input.vehicleId } : { userId: input.userId }),
      },
      include: { plan: { select: { zoneIds: true, vehicleTypeId: true } } },
    });
    if (!pass) return null;

    const scopeOk = pass.plan.zoneIds.length === 0 || pass.plan.zoneIds.includes(input.zoneId);
    const typeOk = pass.plan.vehicleTypeId === input.vehicleType;
    return scopeOk && typeOk ? pass : null;
  }

  private async resolveDiscount(input: QuoteInput, subtotal: Paise): Promise<Paise> {
    const now = input.startAt;
    const discount = await this.prisma.discount.findFirst({
      where: {
        isActive: true,
        validFrom: { lte: now },
        validTo: { gte: now },
        ...(input.discountCode
          ? { code: input.discountCode.toUpperCase() }
          : { code: null }),
        OR: [{ zoneId: null }, { zoneId: input.zoneId }],
        AND: [{ OR: [{ vehicleTypeId: null }, { vehicleTypeId: input.vehicleType }] }],
      },
      orderBy: { percentOff: "desc" },
    });

    if (!discount) return 0;
    if (discount.maxUses !== null && discount.usedCount >= discount.maxUses) return 0;

    const byPercent = discount.percentOff
      ? Math.round((subtotal * Number(discount.percentOff)) / 100)
      : 0;
    const byFlat = discount.flatOff ?? 0;
    return clampToCap(Math.max(byPercent, byFlat), subtotal);
  }

  private ruleLabel(type: TariffRuleType, multiplier: number | null, flat: Paise | null): string {
    const names: Record<TariffRuleType, string> = {
      PEAK_HOUR: "Peak hour",
      WEEKEND: "Weekend",
      HOLIDAY: "Public holiday",
      EVENT: "Event",
      NIGHT: "Night rate",
      VIP: "VIP zone",
      COMMERCIAL: "Commercial vehicle",
      SUBSCRIBER: "Subscriber rate",
    };
    const name = names[type];
    if (flat !== null) return `${name} surcharge`;
    return multiplier !== null ? `${name} (×${multiplier})` : name;
  }
}
