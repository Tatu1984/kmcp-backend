import { describe, expect, it, vi } from "vitest";
import { PaymentMode, ShiftStatus } from "@prisma/client";

import { ShiftsService } from "../src/modules/shifts/shifts.service";
import { AppException } from "../src/common/errors/app.exception";

/**
 * Cash reconciliation.
 *
 * This is the first thing an auditor looks at, and the place where a rounding
 * shortcut or a silent correction turns into a person being wrongly accused —
 * or a theft going unnoticed. Nothing here nets off or tidies up.
 */

const ATTENDANT = {
  id: "usr_1",
  role: "ATTENDANT",
  attendantId: "att_1",
  vendorId: null,
  zoneIds: [],
  isZoneScoped: true,
};

const SUPERVISOR = {
  id: "usr_2",
  role: "ADMIN",
  attendantId: null,
  vendorId: null,
  zoneIds: [],
  isZoneScoped: false,
};

const OPEN_SHIFT = {
  id: "shf_1",
  attendantId: "att_1",
  vendorId: "ven_1",
  zoneId: "zn_1",
  status: ShiftStatus.OPEN,
  cashExpected: 0,
  cashDeposited: null,
  varianceAmount: null,
};

function makeService(overrides: Record<string, any> = {}) {
  const prisma: any = {
    shift: {
      findFirst: vi.fn().mockResolvedValue(overrides.openShift ?? null),
      findUnique: vi.fn().mockResolvedValue(overrides.shift ?? OPEN_SHIFT),
      create: vi.fn().mockImplementation(({ data }: any) => ({ id: "shf_new", ...data })),
      update: vi.fn().mockImplementation(({ data }: any) => ({ ...OPEN_SHIFT, ...data })),
    },
    attendant: {
      findUnique: vi
        .fn()
        .mockResolvedValue(overrides.attendant ?? { id: "att_1", vendorId: "ven_1", isActive: true, defaultZoneId: "zn_1" }),
    },
    payment: { groupBy: vi.fn().mockResolvedValue(overrides.payments ?? []) },
    parkingSession: { count: vi.fn().mockResolvedValue(overrides.runningSessions ?? 0) },
    $transaction: vi.fn(async (arg: any) => (typeof arg === "function" ? arg(prisma) : Promise.all(arg))),
  };
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  return { service: new ShiftsService(prisma, audit as any), prisma, audit };
}

/** Payment rows as groupBy returns them. */
const cash = (amount: number, refunded = 0) => ({
  mode: PaymentMode.CASH,
  _sum: { amount, refundedAmount: refunded },
});
const upi = (amount: number, refunded = 0) => ({
  mode: PaymentMode.UPI_QR,
  _sum: { amount, refundedAmount: refunded },
});

async function expectRefusal(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toBeInstanceOf(AppException);
  await promise.catch((error: AppException) => expect(error.code).toBe(code));
}

describe("opening a shift", () => {
  it("returns the existing shift rather than opening a second", async () => {
    const { service, prisma } = makeService({ openShift: OPEN_SHIFT });

    const result: any = await service.open({} as any, ATTENDANT as any, {});

    // Two open shifts would split a day's cash across records nobody could
    // reconcile against one deposit.
    expect(result.alreadyOpen).toBe(true);
    expect(prisma.shift.create).not.toHaveBeenCalled();
  });

  it("refuses a deactivated attendant", async () => {
    const { service } = makeService({
      attendant: { id: "att_1", vendorId: "ven_1", isActive: false, defaultZoneId: null },
    });
    await expectRefusal(service.open({} as any, ATTENDANT as any, {}), "FORBIDDEN");
  });

  it("refuses anyone who is not an attendant", async () => {
    const { service } = makeService();
    await expectRefusal(service.open({} as any, SUPERVISOR as any, {}), "FORBIDDEN");
  });
});

describe("closing a shift", () => {
  it("records a matching count as closed, not flagged", async () => {
    const { service, prisma } = makeService({ payments: [cash(5000), upi(3000)] });

    const result: any = await service.close(
      "shf_1",
      { cashDeposited: 5000 } as any,
      ATTENDANT as any,
      {},
    );

    expect(prisma.shift.update.mock.calls[0][0].data.status).toBe(ShiftStatus.CLOSED);
    expect(result.variance).toMatchObject({ amount: 0, matched: true });
  });

  it("flags a short count and says how short", async () => {
    const { service, prisma } = makeService({ payments: [cash(5000)] });

    const result: any = await service.close(
      "shf_1",
      { cashDeposited: 4500 } as any,
      ATTENDANT as any,
      {},
    );

    expect(prisma.shift.update.mock.calls[0][0].data.status).toBe(ShiftStatus.VARIANCE_FLAGGED);
    expect(result.variance).toMatchObject({ amount: -500, short: true });
  });

  it("flags an over count too", async () => {
    const { service } = makeService({ payments: [cash(5000)] });

    // Usually means a session was never recorded, which matters as much as a
    // shortfall — it is revenue with no parking event behind it.
    const result: any = await service.close(
      "shf_1",
      { cashDeposited: 5500 } as any,
      ATTENDANT as any,
      {},
    );

    expect(result.variance).toMatchObject({ amount: 500, over: true });
  });

  it("counts refunds against the cash expected", async () => {
    const { service, prisma } = makeService({ payments: [cash(5000, 1200)] });

    await service.close("shf_1", { cashDeposited: 3800 } as any, ATTENDANT as any, {});

    // ₹50 taken, ₹12 handed back, ₹38 to deposit.
    expect(prisma.shift.update.mock.calls[0][0].data.cashExpected).toBe(3800);
    expect(prisma.shift.update.mock.calls[0][0].data.varianceAmount).toBe(0);
  });

  it("keeps digital collection out of the cash figure", async () => {
    const { service, prisma } = makeService({ payments: [cash(2000), upi(9000)] });

    await service.close("shf_1", { cashDeposited: 2000 } as any, ATTENDANT as any, {});

    const data = prisma.shift.update.mock.calls[0][0].data;
    // Digital money is already banked; asking an attendant to hand it over
    // would be asking them for money they never held.
    expect(data.cashExpected).toBe(2000);
    expect(data.digitalTotal).toBe(9000);
    expect(data.varianceAmount).toBe(0);
  });

  it("refuses to close over a running session", async () => {
    const { service } = makeService({ runningSessions: 2 });
    await expectRefusal(
      service.close("shf_1", { cashDeposited: 0 } as any, ATTENDANT as any, {}),
      "SESSION_ALREADY_ACTIVE",
    );
  });

  it("refuses to close a shift twice", async () => {
    const { service } = makeService({ shift: { ...OPEN_SHIFT, status: ShiftStatus.CLOSED } });
    await expectRefusal(
      service.close("shf_1", { cashDeposited: 0 } as any, ATTENDANT as any, {}),
      "SHIFT_ALREADY_CLOSED",
    );
  });

  it("refuses to close somebody else's shift", async () => {
    const { service } = makeService({ shift: { ...OPEN_SHIFT, attendantId: "att_other" } });
    await expectRefusal(
      service.close("shf_1", { cashDeposited: 0 } as any, ATTENDANT as any, {}),
      "FORBIDDEN",
    );
  });
});

describe("verifying a shift", () => {
  const CLOSED = {
    ...OPEN_SHIFT,
    status: ShiftStatus.VARIANCE_FLAGGED,
    cashExpected: 5000,
    cashDeposited: 4500,
    varianceAmount: -500,
  };

  it("refuses to verify an open shift", async () => {
    const { service } = makeService({ shift: OPEN_SHIFT });
    await expectRefusal(service.verify("shf_1", {} as any, SUPERVISOR as any, {}), "SHIFT_ALREADY_OPEN");
  });

  it("refuses to let an attendant verify their own shift", async () => {
    const { service } = makeService({ shift: CLOSED });

    // One person declaring and confirming is how cash goes missing.
    await expectRefusal(service.verify("shf_1", {} as any, ATTENDANT as any, {}), "FORBIDDEN");
  });

  it("recomputes the variance against what was actually received", async () => {
    const { service, prisma } = makeService({ shift: CLOSED });

    // The attendant declared ₹45; the counting officer received ₹40.
    await service.verify("shf_1", { cashReceived: 4000 } as any, SUPERVISOR as any, {});

    expect(prisma.shift.update.mock.calls[0][0].data).toMatchObject({
      cashDeposited: 4000,
      varianceAmount: -1000,
      status: ShiftStatus.VERIFIED,
    });
  });

  it("is a no-op once already verified", async () => {
    const { service, prisma } = makeService({ shift: { ...CLOSED, status: ShiftStatus.VERIFIED } });
    await service.verify("shf_1", {} as any, SUPERVISOR as any, {});
    expect(prisma.shift.update).not.toHaveBeenCalled();
  });
});
