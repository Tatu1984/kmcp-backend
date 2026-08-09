import { describe, expect, it, vi } from "vitest";
import { PaymentMode, SettlementStatus } from "@prisma/client";

import { SettlementsService } from "../src/modules/settlements/settlements.service";
import { AppException } from "../src/common/errors/app.exception";

/**
 * Settlement arithmetic.
 *
 * This decides what a vendor is paid and what the authority keeps, and posts
 * both to a ledger somebody will audit. The cases below are the ones where an
 * innocent-looking shortcut costs real money: netting refunds, rounding
 * commission per line, and letting the same payment be settled twice.
 */

const ADMIN = {
  id: "usr_1",
  role: "ADMIN",
  name: "Admin",
  attendantId: null,
  vendorId: null,
  zoneIds: [],
  isZoneScoped: false,
  sessionId: "sess_1",
};

const VENDOR = { id: "ven_1", orgName: "Metro Parking", commissionPct: 20 };

const PERIOD = {
  vendorId: "ven_1",
  periodStart: new Date("2026-07-01T00:00:00Z"),
  periodEnd: new Date("2026-07-31T23:59:59Z"),
};

/** A captured payment as the generator selects it. */
const payment = (id: string, amount: number, refunded = 0, mode: PaymentMode = PaymentMode.CASH) => ({
  id,
  amount,
  refundedAmount: refunded,
  mode,
});

function makeService(overrides: Record<string, any> = {}) {
  const created: any[] = [];
  const lines: any[] = [];
  const ledger: any[] = [];

  const prisma: any = {
    vendor: { findUnique: vi.fn().mockResolvedValue(overrides.vendor ?? VENDOR) },
    payment: { findMany: vi.fn().mockResolvedValue(overrides.payments ?? []) },
    settlement: {
      findUnique: vi.fn().mockResolvedValue(overrides.existing ?? null),
      // Both `generate` and each workflow step end by re-reading the row, so
      // this hands back whatever was just written rather than a fixed stub.
      findFirst: vi.fn().mockImplementation(() => overrides.settlement ?? created.at(-1) ?? null),
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
      create: vi.fn().mockImplementation(({ data }: any) => {
        const row = { id: "stl_new", _count: { lines: 0 }, vendor: VENDOR, ...data };
        created.push(row);
        return row;
      }),
      update: vi.fn().mockImplementation(({ data }: any) => ({ ...(overrides.settlement ?? {}), ...data })),
      groupBy: vi.fn().mockResolvedValue([]),
      aggregate: vi.fn().mockResolvedValue({ _sum: {} }),
    },
    settlementLine: {
      createMany: vi.fn().mockImplementation(({ data }: any) => {
        lines.push(...data);
        return { count: data.length };
      }),
      findMany: vi.fn().mockResolvedValue([]),
    },
    ledgerEntry: {
      createMany: vi.fn().mockImplementation(({ data }: any) => {
        ledger.push(...data);
        return { count: data.length };
      }),
      findMany: vi.fn().mockResolvedValue([]),
    },
    $transaction: vi.fn(async (arg: any) =>
      typeof arg === "function" ? arg(prisma) : Promise.all(arg),
    ),
  };

  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  return {
    service: new SettlementsService(prisma, audit as any),
    prisma,
    audit,
    created,
    lines,
    ledger,
  };
}

describe("generating a settlement", () => {
  it("splits gross into the vendor's commission and the authority's share", async () => {
    const { service, created } = makeService({
      payments: [payment("pay_1", 10_000), payment("pay_2", 5_000)],
    });

    await service.generate(PERIOD, ADMIN as any, {});

    const row = created[0];
    expect(row.grossCollected).toBe(15_000);
    // 20% of each line: 2000 + 1000.
    expect(row.commissionAmount).toBe(3_000);
    expect(row.vendorShare).toBe(3_000);
    expect(row.governmentShare).toBe(12_000);
    // The two halves must always add back to gross.
    expect(row.vendorShare + row.governmentShare).toBe(row.grossCollected);
  });

  it("nets refunds off before commission is earned", async () => {
    const { service, created, lines } = makeService({
      // ₹100 taken, ₹40 given back — commission is owed on ₹60, not ₹100.
      payments: [payment("pay_1", 10_000, 4_000)],
    });

    await service.generate(PERIOD, ADMIN as any, {});

    expect(created[0].grossCollected).toBe(6_000);
    expect(created[0].commissionAmount).toBe(1_200);
    expect(lines[0].amount).toBe(6_000);
  });

  it("separates cash from digital, because only one of them is in a pocket", async () => {
    const { service, created } = makeService({
      payments: [
        payment("pay_1", 10_000, 0, PaymentMode.CASH),
        payment("pay_2", 4_000, 0, PaymentMode.UPI_QR),
        payment("pay_3", 6_000, 0, PaymentMode.CARD),
      ],
    });

    await service.generate(PERIOD, ADMIN as any, {});

    expect(created[0].cashCollected).toBe(10_000);
    expect(created[0].digitalCollected).toBe(10_000);
    expect(created[0].cashCollected + created[0].digitalCollected).toBe(
      created[0].grossCollected,
    );
  });

  it("writes one line per payment, which is what stops it being settled twice", async () => {
    const { service, lines } = makeService({
      payments: [payment("pay_1", 10_000), payment("pay_2", 5_000), payment("pay_3", 2_500)],
    });

    await service.generate(PERIOD, ADMIN as any, {});

    expect(lines).toHaveLength(3);
    expect(lines.map((l) => l.paymentId)).toEqual(["pay_1", "pay_2", "pay_3"]);
  });

  it("only sweeps in payments no settlement has already claimed", async () => {
    const { service, prisma } = makeService({ payments: [payment("pay_1", 10_000)] });

    await service.generate(PERIOD, ADMIN as any, {});

    const where = prisma.payment.findMany.mock.calls[0][0].where;
    expect(where.settlementLines).toEqual({ none: {} });
  });

  it("refuses a second settlement for a period already covered", async () => {
    const { service } = makeService({
      existing: { id: "stl_old", status: SettlementStatus.APPROVED },
      payments: [payment("pay_1", 10_000)],
    });

    await expect(service.generate(PERIOD, ADMIN as any, {})).rejects.toBeInstanceOf(AppException);
  });

  it("refuses to build an empty settlement", async () => {
    const { service } = makeService({ payments: [] });

    await expect(service.generate(PERIOD, ADMIN as any, {})).rejects.toBeInstanceOf(AppException);
  });

  it("keeps the halves reconciling even when every line rounds up", async () => {
    // 33% of 101 is 33.33 — each line rounds, and the shares must still sum.
    const { service, created } = makeService({
      vendor: { ...VENDOR, commissionPct: 33 },
      payments: Array.from({ length: 7 }, (_, i) => payment(`pay_${i}`, 101)),
    });

    await service.generate(PERIOD, ADMIN as any, {});

    const row = created[0];
    expect(row.vendorShare + row.governmentShare).toBe(row.grossCollected);
  });
});

describe("approving a settlement", () => {
  const APPROVABLE = {
    id: "stl_1",
    status: SettlementStatus.PENDING_APPROVAL,
    periodStart: new Date("2026-07-01T00:00:00Z"),
    grossCollected: 15_000,
    cashCollected: 10_000,
    digitalCollected: 5_000,
    commissionAmount: 3_000,
    vendorShare: 3_000,
    governmentShare: 12_000,
    _count: { lines: 2 },
    vendor: VENDOR,
  };

  it("posts a ledger whose debits equal its credits", async () => {
    const { service, ledger } = makeService({ settlement: APPROVABLE });

    await service.approve("stl_1", ADMIN as any, {});

    const debits = ledger.reduce((s, e) => s + e.debit, 0);
    const credits = ledger.reduce((s, e) => s + e.credit, 0);
    expect(debits).toBe(15_000);
    expect(credits).toBe(15_000);
  });

  it("books cash and gateway money in, vendor payable and municipal revenue out", async () => {
    const { service, ledger } = makeService({ settlement: APPROVABLE });

    await service.approve("stl_1", ADMIN as any, {});

    const account = (name: string) => ledger.find((e) => e.account === name);
    expect(account("CASH_IN_HAND")?.debit).toBe(10_000);
    expect(account("GATEWAY_RECEIVABLE")?.debit).toBe(5_000);
    expect(account("VENDOR_PAYABLE")?.credit).toBe(3_000);
    expect(account("GOVERNMENT_REVENUE")?.credit).toBe(12_000);
  });

  it("refuses to approve a draft that was never submitted", async () => {
    const { service } = makeService({
      settlement: { ...APPROVABLE, status: SettlementStatus.DRAFT },
    });

    await expect(service.approve("stl_1", ADMIN as any, {})).rejects.toBeInstanceOf(AppException);
  });

  it("refuses to approve one that is already paid", async () => {
    const { service } = makeService({
      settlement: { ...APPROVABLE, status: SettlementStatus.PAID },
    });

    await expect(service.approve("stl_1", ADMIN as any, {})).rejects.toBeInstanceOf(AppException);
  });
});

describe("recording a payout", () => {
  const APPROVED = {
    id: "stl_1",
    status: SettlementStatus.APPROVED,
    periodStart: new Date("2026-07-01T00:00:00Z"),
    grossCollected: 15_000,
    cashCollected: 10_000,
    digitalCollected: 5_000,
    commissionAmount: 3_000,
    vendorShare: 3_000,
    governmentShare: 12_000,
    _count: { lines: 2 },
    vendor: VENDOR,
  };

  it("clears the vendor payable against cash, and balances", async () => {
    const { service, ledger } = makeService({ settlement: APPROVED });

    await service.payout("stl_1", { reference: "SBIN123456789" }, ADMIN as any, {});

    const debits = ledger.reduce((s, e) => s + e.debit, 0);
    const credits = ledger.reduce((s, e) => s + e.credit, 0);
    expect(debits).toBe(credits);
    expect(ledger.find((e) => e.account === "VENDOR_PAYABLE")?.debit).toBe(3_000);
    expect(ledger.find((e) => e.account === "CASH_IN_HAND")?.credit).toBe(3_000);
  });

  it("records the bank reference against the settlement", async () => {
    const { service, prisma } = makeService({ settlement: APPROVED });

    await service.payout("stl_1", { reference: "SBIN123456789" }, ADMIN as any, {});

    expect(prisma.settlement.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ payoutRef: "SBIN123456789", payoutStatus: "MANUAL" }),
      }),
    );
  });

  it("refuses to pay out before approval", async () => {
    const { service } = makeService({
      settlement: { ...APPROVED, status: SettlementStatus.PENDING_APPROVAL },
    });

    await expect(
      service.payout("stl_1", { reference: "SBIN1" }, ADMIN as any, {}),
    ).rejects.toBeInstanceOf(AppException);
  });

  it("refuses to pay out nothing", async () => {
    const { service } = makeService({ settlement: { ...APPROVED, vendorShare: 0 } });

    await expect(
      service.payout("stl_1", { reference: "SBIN1" }, ADMIN as any, {}),
    ).rejects.toBeInstanceOf(AppException);
  });
});

describe("vendor scoping", () => {
  it("confines a vendor to their own settlements", async () => {
    const { service, prisma } = makeService();

    await service.list({ page: 1, pageSize: 25 } as any, {
      ...ADMIN,
      role: "VENDOR",
      vendorId: "ven_1",
    } as any);

    expect(prisma.settlement.findMany.mock.calls[0][0].where).toMatchObject({ vendorId: "ven_1" });
  });
});
