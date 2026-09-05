import { describe, expect, it, vi } from "vitest";
import { AttendantPayMode } from "@prisma/client";

import { AttendantPaymentsService } from "../src/modules/attendant-payments/attendant-payments.service";
import { SYSTEM_ROLES } from "../src/common/rbac/permissions";

/**
 * Who can see what a vendor pays their own staff.
 *
 * The requirement is that this is the vendor's business and nobody else's — the
 * authority included. That cannot be enforced with a permission grant, because
 * `RolesService.can` returns true for a superuser before it reads the list at
 * all, so a SUPER_ADMIN passes `attendant.pay.read` whether or not anybody
 * granted it.
 *
 * The boundary is therefore the caller's `vendorId`, and these tests exist to
 * stop somebody restoring the usual "widen for an admin" branch that every
 * other service in this codebase quite correctly has.
 */

function makeService(rows: unknown[] = []) {
  const prisma = {
    attendantPayment: {
      findMany: vi.fn().mockResolvedValue(rows),
      count: vi.fn().mockResolvedValue(rows.length),
      create: vi.fn().mockResolvedValue({ id: "ap_1" }),
      groupBy: vi.fn().mockResolvedValue([]),
      aggregate: vi.fn().mockResolvedValue({ _sum: { amount: 0 }, _count: { _all: 0 } }),
    },
    attendant: {
      findFirst: vi.fn().mockResolvedValue({ id: "att_1", employeeCode: "KP-001" }),
      findMany: vi.fn().mockResolvedValue([]),
    },
    $transaction: vi.fn().mockImplementation((ops: Promise<unknown>[]) => Promise.all(ops)),
  } as any;
  const audit = { record: vi.fn().mockResolvedValue(undefined) } as any;
  return { service: new AttendantPaymentsService(prisma, audit), prisma, audit };
}

const VENDOR = {
  id: "usr_v1",
  role: SYSTEM_ROLES.VENDOR,
  vendorId: "ven_1",
} as any;

const OTHER_VENDOR = { id: "usr_v2", role: SYSTEM_ROLES.VENDOR, vendorId: "ven_2" } as any;
const SUPER_ADMIN = { id: "usr_s", role: SYSTEM_ROLES.SUPER_ADMIN } as any;
const ADMIN = { id: "usr_a", role: SYSTEM_ROLES.ADMIN } as any;
const AUDITOR = { id: "usr_x", role: SYSTEM_ROLES.AUDITOR } as any;
const ATTENDANT = { id: "usr_att", role: SYSTEM_ROLES.ATTENDANT, attendantId: "att_1" } as any;

const QUERY = { page: 1, pageSize: 20 } as any;

describe("who may read staff payments", () => {
  it("lets a vendor read their own", async () => {
    const { service, prisma } = makeService();
    await service.list(QUERY, VENDOR);
    expect(prisma.attendantPayment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ vendorId: "ven_1" }) }),
    );
  });

  // The whole point of the feature. A superuser holds every permission by
  // definition, so if the boundary were a grant this would pass and the wage
  // bill of every vendor in the city would be readable from the portal.
  it("refuses a superuser", async () => {
    const { service } = makeService();
    await expect(service.list(QUERY, SUPER_ADMIN)).rejects.toThrow();
  });

  it("refuses an administrator", async () => {
    const { service } = makeService();
    await expect(service.list(QUERY, ADMIN)).rejects.toThrow();
  });

  it("refuses an auditor", async () => {
    const { service } = makeService();
    await expect(service.list(QUERY, AUDITOR)).rejects.toThrow();
  });

  // An attendant does not see their own pay here either. What they are owed is
  // between them and their employer; this table is the employer's record.
  it("refuses an attendant", async () => {
    const { service } = makeService();
    await expect(service.list(QUERY, ATTENDANT)).rejects.toThrow();
  });

  it("refuses the summary to anyone without a vendor", async () => {
    const { service } = makeService();
    await expect(service.summary(QUERY, SUPER_ADMIN)).rejects.toThrow();
  });
});

describe("one vendor cannot reach another's", () => {
  it("ignores a vendorId smuggled in through the query", async () => {
    const { service, prisma } = makeService();
    await service.list({ ...QUERY, vendorId: "ven_2" } as any, VENDOR);
    const where = prisma.attendantPayment.findMany.mock.calls[0][0].where;
    expect(where.vendorId).toBe("ven_1");
  });

  it("refuses to record a payment against another vendor's attendant", async () => {
    const { service, prisma } = makeService();
    prisma.attendant.findFirst.mockResolvedValue(null); // not on this vendor's books
    await expect(
      service.create(
        { attendantId: "att_9", amount: 500_00, mode: AttendantPayMode.CASH } as any,
        OTHER_VENDOR,
        {},
      ),
    ).rejects.toThrow();
    expect(prisma.attendantPayment.create).not.toHaveBeenCalled();
  });
});

describe("recording a payment", () => {
  it("stamps the caller's own vendor and user, not anything they sent", async () => {
    const { service, prisma } = makeService();
    await service.create(
      {
        attendantId: "att_1",
        amount: 1_200_00,
        mode: AttendantPayMode.UPI,
        reference: "UPI-882931",
        // A caller trying to file this under someone else's vendor.
        vendorId: "ven_2",
        recordedById: "usr_someone_else",
      } as any,
      VENDOR,
      {},
    );

    const data = prisma.attendantPayment.create.mock.calls[0][0].data;
    expect(data.vendorId).toBe("ven_1");
    expect(data.recordedById).toBe("usr_v1");
    expect(data.amount).toBe(1_200_00);
    expect(data.mode).toBe(AttendantPayMode.UPI);
  });

  it("writes an audit entry so a payment cannot be recorded invisibly", async () => {
    const { service, audit } = makeService();
    await service.create(
      { attendantId: "att_1", amount: 900_00, mode: AttendantPayMode.CASH } as any,
      VENDOR,
      {},
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "ATTENDANT_PAYMENT_RECORD" }),
    );
  });
});
