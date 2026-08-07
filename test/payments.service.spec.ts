import { describe, expect, it, vi } from "vitest";
import { PaymentMode, PaymentStatus, SessionStatus } from "@prisma/client";

import { PaymentsService } from "../src/modules/payments/payments.service";
import { AppException } from "../src/common/errors/app.exception";

/**
 * The money rules.
 *
 * Every case here is something that, if it broke, would either overcharge a
 * citizen, let someone park for a rupee, or leave the authority's cash book
 * disagreeing with its bank. None of them are visible from the outside until
 * an audit finds them months later.
 */

const SESSION = {
  id: "ses_1",
  code: "KMCP-AAA111",
  status: SessionStatus.COMPLETED,
  payableAmount: 6490, // ₹64.90
  shiftId: "shf_1",
  attendantId: "att_1",
};

const USER = { id: "usr_1", role: "ATTENDANT" as const, attendantId: "att_1", vendorId: null, zoneIds: [] };

function makeService(overrides: Record<string, any> = {}) {
  const prisma: any = {
    payment: {
      findUnique: vi.fn().mockResolvedValue(overrides.replay ?? null),
      findFirst: vi.fn().mockResolvedValue(overrides.byOrder ?? null),
      aggregate: vi.fn().mockResolvedValue(
        overrides.aggregate ?? { _sum: { amount: null, refundedAmount: null } },
      ),
      create: vi.fn().mockImplementation(({ data }: any) => ({ id: "pay_1", ...data })),
      update: vi.fn().mockImplementation(({ data }: any) => ({ id: "pay_1", ...data })),
      groupBy: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
    },
    parkingSession: { findUnique: vi.fn().mockResolvedValue(overrides.session ?? SESSION) },
    shift: { update: vi.fn() },
    receipt: {
      findUnique: vi.fn().mockResolvedValue(overrides.receipt ?? null),
      create: vi.fn().mockImplementation(({ data }: any) => ({ id: "rcp_1", ...data })),
      count: vi.fn().mockResolvedValue(0),
    },
    systemConfig: { findUnique: vi.fn().mockResolvedValue({ value: "RCPT/" }) },
    $transaction: vi.fn(async (arg: any) => (typeof arg === "function" ? arg(prisma) : Promise.all(arg))),
  };

  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  const razorpay = {
    isConfigured: true,
    keyId: "rzp_test_key",
    createOrder: vi.fn().mockResolvedValue({ id: "order_ABC", amount: 6490, currency: "INR" }),
    refund: vi.fn().mockResolvedValue({ id: "rfnd_1", amount: 1000, status: "processed" }),
    verifyCheckoutSignature: vi.fn().mockReturnValue(overrides.signatureValid ?? true),
    verifyWebhookSignature: vi.fn().mockReturnValue(overrides.webhookValid ?? true),
    ...(overrides.razorpay ?? {}),
  };

  return { service: new PaymentsService(prisma, audit as any, razorpay as any), prisma, audit, razorpay };
}

async function expectRefusal(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toBeInstanceOf(AppException);
  await promise.catch((error: AppException) => expect(error.code).toBe(code));
}

describe("collecting payment", () => {
  const CASH = { sessionId: "ses_1", mode: PaymentMode.CASH, idempotencyKey: "idem_00000001" };

  it("charges what the session says, never what the caller says", async () => {
    const { service, prisma } = makeService();
    // The DTO has no amount field at all; this asserts where the figure comes from.
    await service.collect(CASH as any, USER as any, {});
    expect(prisma.payment.create.mock.calls[0][0].data.amount).toBe(6490);
  });

  it("returns the original payment when a collection is replayed", async () => {
    const { service, prisma } = makeService({
      replay: { id: "pay_original", amount: 6490, status: PaymentStatus.CAPTURED },
    });

    const result: any = await service.collect(CASH as any, USER as any, {});

    // An attendant double-tapping on a bad connection must not charge twice.
    expect(result.replayed).toBe(true);
    expect(result.id).toBe("pay_original");
    expect(prisma.payment.create).not.toHaveBeenCalled();
  });

  it("captures cash immediately and moves the shift's expected float", async () => {
    const { service, prisma } = makeService();
    await service.collect(CASH as any, USER as any, {});

    expect(prisma.payment.create.mock.calls[0][0].data.status).toBe(PaymentStatus.CAPTURED);
    // What the attendant will be asked to deposit at shift close.
    expect(prisma.shift.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { cashExpected: { increment: 6490 } } }),
    );
  });

  it("only charges the balance when part has already been paid", async () => {
    const { service, prisma } = makeService({
      aggregate: { _sum: { amount: 4000, refundedAmount: 0 } },
    });
    await service.collect(CASH as any, USER as any, {});
    expect(prisma.payment.create.mock.calls[0][0].data.amount).toBe(2490);
  });

  it("refuses a second payment once the session is settled", async () => {
    const { service } = makeService({ aggregate: { _sum: { amount: 6490, refundedAmount: 0 } } });
    await expectRefusal(service.collect(CASH as any, USER as any, {}), "DUPLICATE_RESOURCE");
  });

  it("refuses to take money for a session that has no fare yet", async () => {
    const { service } = makeService({ session: { ...SESSION, payableAmount: null } });
    await expectRefusal(service.collect(CASH as any, USER as any, {}), "SESSION_NOT_ACTIVE");
  });

  it("refuses to take money for a cancelled session", async () => {
    const { service } = makeService({ session: { ...SESSION, status: SessionStatus.CANCELLED } });
    await expectRefusal(service.collect(CASH as any, USER as any, {}), "SESSION_NOT_ACTIVE");
  });

  it("leaves a gateway payment pending until the gateway confirms it", async () => {
    const { service, prisma, razorpay } = makeService();
    const result: any = await service.collect(
      { ...CASH, mode: PaymentMode.UPI_QR } as any,
      USER as any,
      {},
    );

    expect(razorpay.createOrder).toHaveBeenCalledWith(6490, "KMCP-AAA111", expect.any(Object));
    expect(prisma.payment.create.mock.calls[0][0].data.status).toBe(PaymentStatus.PENDING);
    expect(result.gatewayOrder.id).toBe("order_ABC");
  });
});

describe("confirming a checkout", () => {
  const PENDING = {
    id: "pay_1",
    status: PaymentStatus.PENDING,
    amount: 6490,
    gatewayOrderId: "order_ABC",
  };
  const CALLBACK = {
    razorpayOrderId: "order_ABC",
    razorpayPaymentId: "pay_rzp_1",
    razorpaySignature: "0".repeat(64),
  };

  it("rejects a signature that does not verify", async () => {
    const { service, prisma } = makeService({ signatureValid: false });
    prisma.payment.findUnique = vi.fn().mockResolvedValue(PENDING);

    // Without this check, anyone could POST "I paid" and be believed.
    await expectRefusal(
      service.verify("pay_1", CALLBACK as any, USER as any, {}),
      "PAYMENT_SIGNATURE_INVALID",
    );
  });

  it("rejects a callback quoting a different order", async () => {
    const { service, prisma } = makeService();
    prisma.payment.findUnique = vi.fn().mockResolvedValue(PENDING);

    await expectRefusal(
      service.verify("pay_1", { ...CALLBACK, razorpayOrderId: "order_SOMEONE_ELSE" } as any, USER as any, {}),
      "PAYMENT_SIGNATURE_INVALID",
    );
  });

  it("is a no-op when the webhook already captured it", async () => {
    const { service, prisma } = makeService();
    prisma.payment.findUnique = vi.fn().mockResolvedValue({ ...PENDING, status: PaymentStatus.CAPTURED });

    const result: any = await service.verify("pay_1", CALLBACK as any, USER as any, {});

    // The callback and the webhook race on every single payment.
    expect(result.replayed).toBe(true);
    expect(prisma.payment.update).not.toHaveBeenCalled();
  });
});

describe("the webhook", () => {
  const EVENT = (amount: number, type = "payment.captured") => ({
    event: type,
    payload: { payment: { entity: { id: "pay_rzp_1", order_id: "order_ABC", amount } } },
  });

  it("refuses an unsigned or forged event", async () => {
    const { service } = makeService({ webhookValid: false });
    await expectRefusal(
      service.handleWebhook("{}", "bad-signature", EVENT(6490)),
      "PAYMENT_SIGNATURE_INVALID",
    );
  });

  it("refuses to capture when the amount does not match the order", async () => {
    const { service, prisma } = makeService({
      byOrder: { id: "pay_1", status: PaymentStatus.PENDING, amount: 6490 },
    });

    // Paying ₹1 against a ₹64.90 order is the fraud this exists to stop.
    const result = await service.handleWebhook("{}", "sig", EVENT(100));

    expect(result).toMatchObject({ handled: false, reason: "amount mismatch" });
    expect(prisma.payment.update.mock.calls[0][0].data.status).toBeUndefined();
  });

  it("captures when the amount matches", async () => {
    const { service, prisma } = makeService({
      byOrder: { id: "pay_1", status: PaymentStatus.PENDING, amount: 6490 },
    });
    prisma.payment.findUnique = vi.fn().mockResolvedValue({ status: PaymentStatus.PENDING });

    const result = await service.handleWebhook("{}", "sig", EVENT(6490));
    expect(result).toMatchObject({ handled: true });
  });

  it("acknowledges an event for an order it does not recognise", async () => {
    const { service } = makeService({ byOrder: null });

    // Razorpay retries until it gets a 2xx. Throwing on someone else's event
    // would have it hammering this endpoint forever.
    const result = await service.handleWebhook("{}", "sig", EVENT(6490));
    expect(result).toMatchObject({ handled: false, reason: "order not recognised" });
  });

  it("does not overwrite a captured payment with a later failure event", async () => {
    const { service, prisma } = makeService({
      byOrder: { id: "pay_1", status: PaymentStatus.CAPTURED, amount: 6490 },
    });

    await service.handleWebhook("{}", "sig", EVENT(6490, "payment.failed"));
    expect(prisma.payment.update).not.toHaveBeenCalled();
  });
});

describe("refunds", () => {
  const CAPTURED = {
    id: "pay_1",
    mode: PaymentMode.UPI_QR,
    status: PaymentStatus.CAPTURED,
    amount: 6490,
    refundedAmount: 0,
    gatewayPaymentId: "pay_rzp_1",
  };

  it("refuses to refund more than remains", async () => {
    const { service, prisma } = makeService();
    prisma.payment.findUnique = vi.fn().mockResolvedValue({ ...CAPTURED, refundedAmount: 6000 });

    await expectRefusal(
      service.refund("pay_1", { amount: 1000, reason: "overcharged" } as any, USER as any, {}),
      "VALIDATION_FAILED",
    );
  });

  it("refuses to refund a payment that was never captured", async () => {
    const { service, prisma } = makeService();
    prisma.payment.findUnique = vi.fn().mockResolvedValue({ ...CAPTURED, status: PaymentStatus.PENDING });

    await expectRefusal(
      service.refund("pay_1", { reason: "not taken" } as any, USER as any, {}),
      "PAYMENT_NOT_CONFIRMED",
    );
  });

  it("marks a part refund as partially refunded", async () => {
    const { service, prisma } = makeService();
    prisma.payment.findUnique = vi.fn().mockResolvedValue(CAPTURED);

    await service.refund("pay_1", { amount: 1000, reason: "overcharged by an hour" } as any, USER as any, {});

    expect(prisma.payment.update.mock.calls[0][0].data).toMatchObject({
      refundedAmount: 1000,
      status: PaymentStatus.PARTIALLY_REFUNDED,
    });
  });

  it("refunds the whole balance when no amount is given", async () => {
    const { service, prisma } = makeService();
    prisma.payment.findUnique = vi.fn().mockResolvedValue(CAPTURED);

    await service.refund("pay_1", { reason: "session cancelled in error" } as any, USER as any, {});

    expect(prisma.payment.update.mock.calls[0][0].data).toMatchObject({
      refundedAmount: 6490,
      status: PaymentStatus.REFUNDED,
    });
  });

  it("does not call the gateway to refund cash", async () => {
    const { service, prisma, razorpay } = makeService();
    prisma.payment.findUnique = vi.fn().mockResolvedValue({
      ...CAPTURED,
      mode: PaymentMode.CASH,
      gatewayPaymentId: null,
    });

    await service.refund("pay_1", { reason: "returned at the counter" } as any, USER as any, {});

    // The money never went through Razorpay, so it cannot come back through it.
    expect(razorpay.refund).not.toHaveBeenCalled();
    expect(prisma.payment.update).toHaveBeenCalled();
  });
});

describe("receipts", () => {
  it("never issues a second receipt for the same payment", async () => {
    const { service, prisma } = makeService({
      receipt: { id: "rcp_existing", number: "RCPT/26-27/000001" },
    });

    const receipt: any = await service.issueReceipt("pay_1");

    // A receipt number appearing twice is an audit finding.
    expect(receipt.id).toBe("rcp_existing");
    expect(prisma.receipt.create).not.toHaveBeenCalled();
  });

  it("numbers receipts within the financial year", async () => {
    const { service, prisma } = makeService();
    await service.issueReceipt("pay_1");
    expect(prisma.receipt.create.mock.calls[0][0].data.number).toMatch(/^RCPT\/\d{2}-\d{2}\/\d{6}$/);
  });
});
