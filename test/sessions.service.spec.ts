import { describe, expect, it, vi } from "vitest";
import { SessionSource, SessionStatus, SlotStatus, SlotType, ZoneStatus } from "@prisma/client";

import { SessionsService } from "../src/modules/sessions/sessions.service";
import { AppException } from "../src/common/errors/app.exception";

/**
 * The guard rails on starting a parking session.
 *
 * Each of these refusals is the difference between a clean revenue trail and a
 * dispute nobody can settle: a car charged twice, a zone that took more cars
 * than it has kerb, a session recorded from a phone half a mile away. They are
 * tested here rather than left to a manual pass, because none of them are
 * visible until the money is already wrong.
 */

const ZONE = {
  id: "zn_1",
  code: "PKS-01",
  name: "Park Street",
  status: ZoneStatus.OPEN,
  capacity: 10,
  boundary: null,
  centerLat: 22.5726,
  centerLng: 88.3639,
  allowedVehicleTypeIds: [SlotType.CAR, SlotType.TWO_WHEELER],
  vendorZones: [{ vendorId: "ven_1" }],
};

const ATTENDANT_USER = {
  id: "usr_1",
  role: "ATTENDANT" as const,
  attendantId: "att_1",
  vendorId: null,
  zoneIds: ["zn_1"],
};

function makeService(overrides: Record<string, any> = {}) {
  /**
   * The bay table, modelled as rows rather than stubbed calls.
   *
   * Both bay transitions are conditional `updateMany`s and the status in the
   * `where` clause *is* the mechanism — a mock that ignored it would report
   * success whatever the service asked for, which is the one thing these cases
   * exist to catch. So the row is kept here, `findUnique` reads it and
   * `updateMany` only writes when the condition still holds.
   */
  const slots: Record<string, any> = overrides.slot
    ? { [overrides.slot.id]: { ...overrides.slot } }
    : {};

  const prisma: any = {
    parkingSession: {
      findUnique: vi.fn().mockResolvedValue(overrides.replay ?? null),
      findFirst: vi.fn().mockResolvedValue(overrides.activeForPlate ?? null),
      count: vi.fn().mockResolvedValue(overrides.occupied ?? 0),
      create: vi.fn().mockImplementation(({ data }: any) => ({ id: "ses_1", ...data })),
      update: vi.fn(),
    },
    zone: { findUnique: vi.fn().mockResolvedValue(overrides.zone ?? ZONE) },
    vehicle: {
      findUnique: vi.fn().mockResolvedValue(overrides.vehicle ?? null),
      create: vi.fn().mockResolvedValue({ id: "veh_1", plateNumber: "WB02AB1234" }),
    },
    vehicleType: { findUnique: vi.fn().mockResolvedValue({ id: "vt_car", code: SlotType.CAR }) },
    attendant: { findUnique: vi.fn().mockResolvedValue({ id: "att_1", vendorId: "ven_1" }) },
    shift: { findFirst: vi.fn().mockResolvedValue(overrides.shift ?? null), update: vi.fn() },
    slot: {
      findUnique: vi.fn(async ({ where }: any) => slots[where.id] ?? null),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const row = slots[where.id];
        if (!row || (where.status !== undefined && row.status !== where.status)) {
          return { count: 0 };
        }
        Object.assign(row, data);
        return { count: 1 };
      }),
    },
    systemConfig: { findUnique: vi.fn().mockResolvedValue(overrides.config ?? null) },
    $transaction: vi.fn(async (fn: any) => fn(prisma)),
  };

  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  const quotes = { quote: vi.fn() };

  // No key is passed by these cases, so the store is never consulted; it is
  // here because the constructor asks for it.
  const idempotency = {
    run: vi.fn(async (_scope: string, _key: string, work: () => Promise<unknown>) => ({
      value: await work(),
      replayed: false,
    })),
  };

  const service = new SessionsService(prisma as any, audit as any, quotes as any, idempotency as any);
  return { service, prisma, audit, quotes, idempotency, slots };
}

const START = {
  zoneId: "zn_1",
  plateNumber: "WB 02 AB 1234",
  vehicleType: SlotType.CAR,
  source: SessionSource.ATTENDANT_APP,
};

async function expectRefusal(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toBeInstanceOf(AppException);
  await promise.catch((error: AppException) => expect(error.code).toBe(code));
}

describe("starting a session", () => {
  it("normalises the plate before recording it", async () => {
    const { service, prisma } = makeService();
    await service.start(START as any, ATTENDANT_USER as any, {});
    expect(prisma.parkingSession.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ plateNumber: "WB02AB1234" }) }),
    );
  });

  it("refuses a registration number that is not a plate", async () => {
    const { service } = makeService();
    await expectRefusal(
      service.start({ ...START, plateNumber: "NOT A PLATE" } as any, ATTENDANT_USER as any, {}),
      "VALIDATION_FAILED",
    );
  });

  it("returns the original session when an offline event is replayed", async () => {
    const original = { id: "ses_original", code: "KMCP-AAA111" };
    const { service, prisma } = makeService({ replay: original });

    const result: any = await service.start(
      { ...START, clientEventId: "evt_00000001" } as any,
      ATTENDANT_USER as any,
      {},
    );

    // The whole point: a replayed start creates nothing and charges nothing.
    expect(result.replayed).toBe(true);
    expect(result.id).toBe("ses_original");
    expect(prisma.parkingSession.create).not.toHaveBeenCalled();
  });

  it("refuses a second live session for the same plate", async () => {
    const { service } = makeService({
      activeForPlate: {
        id: "ses_live",
        code: "KMCP-LIVE01",
        zone: { name: "Camac Street" },
        startAt: new Date(),
      },
    });
    await expectRefusal(service.start(START as any, ATTENDANT_USER as any, {}), "SESSION_ALREADY_ACTIVE");
  });

  it("refuses when the zone is not open", async () => {
    const { service } = makeService({ zone: { ...ZONE, status: ZoneStatus.MAINTENANCE } });
    await expectRefusal(service.start(START as any, ATTENDANT_USER as any, {}), "ZONE_CLOSED");
  });

  it("refuses a vehicle type the zone does not permit", async () => {
    const { service } = makeService();
    await expectRefusal(
      service.start({ ...START, vehicleType: SlotType.BUS } as any, ATTENDANT_USER as any, {}),
      "VEHICLE_TYPE_NOT_ALLOWED",
    );
  });

  it("refuses once every bay is taken", async () => {
    const { service } = makeService({ occupied: 10 });
    await expectRefusal(service.start(START as any, ATTENDANT_USER as any, {}), "ZONE_AT_CAPACITY");
  });

  it("refuses a start from outside the geo-fence", async () => {
    const { service } = makeService();
    await expectRefusal(
      // Central Kolkata zone, device reporting from well outside it.
      service.start(
        { ...START, location: { lat: 22.9, lng: 88.9 } } as any,
        ATTENDANT_USER as any,
        {},
      ),
      "OUTSIDE_GEOFENCE",
    );
  });

  it("allows a start from inside the geo-fence", async () => {
    const { service, prisma } = makeService();
    await service.start(
      { ...START, location: { lat: 22.5726, lng: 88.3639 } } as any,
      ATTENDANT_USER as any,
      {},
    );
    expect(prisma.parkingSession.create).toHaveBeenCalled();
  });

  it("refuses a blacklisted vehicle", async () => {
    const { service } = makeService({
      vehicle: { id: "veh_x", plateNumber: "WB02AB1234", isBlacklisted: true },
    });
    await expectRefusal(service.start(START as any, ATTENDANT_USER as any, {}), "FORBIDDEN");
  });

  it("attaches the session to the attendant's open shift", async () => {
    const { service, prisma } = makeService({ shift: { id: "shf_1" } });
    await service.start(START as any, ATTENDANT_USER as any, {});

    expect(prisma.parkingSession.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ shiftId: "shf_1" }) }),
    );
    // The shift's session count moves with it, so cash reconciliation later has
    // something to check against.
    expect(prisma.shift.update).toHaveBeenCalled();
  });
});

/**
 * Allocating a specific bay.
 *
 * `slotId` used to be written onto the session and the bay flipped to OCCUPIED
 * with nothing checked at all, which meant the one field the citizen app most
 * needs to display — where is my car — was the one field nobody had validated.
 * A bay in the wrong zone, a motorcycle bay holding a car, a bay already
 * occupied and a bay dug up for works were all accepted silently, and two
 * attendants working the same stretch of kerb could be handed the same bay.
 */
describe("allocating a bay", () => {
  const BAY = {
    id: "slt_1",
    code: "A-12",
    zoneId: "zn_1",
    type: SlotType.CAR,
    status: SlotStatus.AVAILABLE,
  };

  const withBay = { ...START, slotId: "slt_1" };

  it("records the bay and takes it out of the pool", async () => {
    const { service, prisma, slots, audit } = makeService({ slot: BAY });

    await service.start(withBay as any, ATTENDANT_USER as any, {});

    expect(prisma.parkingSession.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ slotId: "slt_1" }) }),
    );
    expect(slots.slt_1.status).toBe(SlotStatus.OCCUPIED);
    // The bay is on the audit row too, so the trail answers "which bay" without
    // a join back to a session that may since have been cancelled.
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "SESSION_START",
        after: expect.objectContaining({ slotId: "slt_1", slotCode: "A-12" }),
      }),
    );
  });

  it("refuses a bay that does not exist", async () => {
    const { service } = makeService();
    await expectRefusal(service.start(withBay as any, ATTENDANT_USER as any, {}), "NOT_FOUND");
  });

  it("refuses a bay in another zone", async () => {
    // The one that matters commercially: the session, its fare and its
    // occupancy would have been recorded against a zone the car was not in.
    const { service, prisma } = makeService({ slot: { ...BAY, zoneId: "zn_other" } });
    await expectRefusal(
      service.start(withBay as any, ATTENDANT_USER as any, {}),
      "VALIDATION_FAILED",
    );
    expect(prisma.parkingSession.create).not.toHaveBeenCalled();
  });

  it("refuses a bay painted for another vehicle type", async () => {
    const { service } = makeService({ slot: { ...BAY, type: SlotType.TWO_WHEELER } });
    await expectRefusal(
      service.start(withBay as any, ATTENDANT_USER as any, {}),
      "VEHICLE_TYPE_NOT_ALLOWED",
    );
  });

  it("refuses a bay that already has a car in it", async () => {
    const { service, prisma } = makeService({ slot: { ...BAY, status: SlotStatus.OCCUPIED } });
    await expectRefusal(
      service.start(withBay as any, ATTENDANT_USER as any, {}),
      "DUPLICATE_RESOURCE",
    );
    expect(prisma.parkingSession.create).not.toHaveBeenCalled();
  });

  it("refuses a bay that is out of service, and says so", async () => {
    const { service } = makeService({ slot: { ...BAY, status: SlotStatus.OUT_OF_SERVICE } });
    const failure: any = await service
      .start(withBay as any, ATTENDANT_USER as any, {})
      .catch((error: AppException) => error);

    expect(failure.code).toBe("ZONE_AT_CAPACITY");
    // An out-of-service bay and an occupied one are different problems to the
    // attendant, so the actual status reaches them rather than "unavailable".
    expect(failure.details[0].issue).toContain(SlotStatus.OUT_OF_SERVICE);
  });

  it("refuses a bay reserved for a permit holder", async () => {
    const { service } = makeService({ slot: { ...BAY, status: SlotStatus.RESERVED } });
    await expectRefusal(
      service.start(withBay as any, ATTENDANT_USER as any, {}),
      "ZONE_AT_CAPACITY",
    );
  });

  it("refuses the attendant who loses the race for the bay", async () => {
    const { service, prisma, slots } = makeService({ slot: BAY });

    // The race as it actually happens: the bay reads AVAILABLE, and by the time
    // this transaction goes to claim it another attendant's has committed.
    // Nothing before the write can prevent that — only the status in the
    // `where` can catch it, which is why the claim is a conditional updateMany
    // and not an update.
    prisma.slot.findUnique = vi.fn(async ({ where }: any) => {
      const seen = slots[where.id];
      slots[where.id] = { ...seen, status: SlotStatus.OCCUPIED };
      return seen;
    });

    await expectRefusal(
      service.start(withBay as any, ATTENDANT_USER as any, {}),
      "DUPLICATE_RESOURCE",
    );

    // The refusal is thrown from inside the transaction, so the real database
    // rolls the session row back with it. The mock cannot model that; what it
    // can show is that the bay was never handed to the second attendant.
    expect(slots.slt_1.status).toBe(SlotStatus.OCCUPIED);
  });

  it("still starts a session with no bay at all", async () => {
    // Most zones are priced for more vehicles than they have painted bays, and
    // the portal and the offline replay path may name none. A required bay here
    // would have stopped those starts outright.
    const { service, prisma } = makeService();
    await service.start(START as any, ATTENDANT_USER as any, {});

    expect(prisma.parkingSession.create).toHaveBeenCalled();
    expect(prisma.slot.findUnique).not.toHaveBeenCalled();
    expect(prisma.slot.updateMany).not.toHaveBeenCalled();
  });
});

describe("ending a session", () => {
  const live = {
    id: "ses_1",
    code: "KMCP-AAA111",
    status: SessionStatus.ACTIVE,
    startAt: new Date("2026-08-06T10:00:00Z"),
    endAt: null,
    zoneId: "zn_1",
    slotId: null,
    vehicleId: "veh_1",
    vehicleTypeId: "vt_car",
    zone: { id: "zn_1", code: "PKS-01", name: "Park Street", boundary: null, centerLat: 22.5726, centerLng: 88.3639 },
  };

  function endService(session: any, quote: any, overrides: Record<string, any> = {}) {
    const { service, prisma, quotes, slots } = makeService(overrides);
    prisma.parkingSession.findFirst = vi.fn().mockResolvedValue(session);
    prisma.parkingSession.update = vi.fn().mockImplementation(({ data }: any) => ({ ...session, ...data }));
    quotes.quote = vi.fn().mockResolvedValue(quote);
    return { service, prisma, quotes, slots };
  }

  const QUOTE = {
    tariffId: "trf_1",
    durationMinutes: 120,
    grossAmount: 3500,
    discountAmount: 0,
    taxAmount: 630,
    penaltyAmount: 0,
    payableAmount: 4130,
  };

  it("prices the session and stores the breakdown", async () => {
    const { service, prisma } = endService(live, QUOTE);

    await service.end(
      "ses_1",
      { endedAt: new Date("2026-08-06T12:00:00Z") } as any,
      ATTENDANT_USER as any,
      {},
    );

    const data = prisma.parkingSession.update.mock.calls[0][0].data;
    expect(data.status).toBe(SessionStatus.COMPLETED);
    expect(data.payableAmount).toBe(4130);
    expect(data.durationMinutes).toBe(120);
    // Stored, not recomputed later: a receipt reprinted next year must show the
    // lines that were actually charged.
    expect(data.fareBreakdown).toEqual(QUOTE);
  });

  it("stores the duration the fare was computed on, not its own", async () => {
    // The quote rounds a part minute up; if the row rounded to nearest, a
    // 95-and-a-half minute stay would be stored as 95 and billed as 96.
    const { service, prisma } = endService(live, { ...QUOTE, durationMinutes: 96 });

    await service.end(
      "ses_1",
      { endedAt: new Date("2026-08-06T11:35:30Z") } as any,
      ATTENDANT_USER as any,
      {},
    );

    expect(prisma.parkingSession.update.mock.calls[0][0].data.durationMinutes).toBe(96);
  });

  it("does not re-price a session that is already completed", async () => {
    const { service, prisma, quotes } = endService(
      { ...live, status: SessionStatus.COMPLETED, payableAmount: 4130 },
      QUOTE,
    );

    const result: any = await service.end("ses_1", {} as any, ATTENDANT_USER as any, {});

    expect(result.replayed).toBe(true);
    expect(quotes.quote).not.toHaveBeenCalled();
    expect(prisma.parkingSession.update).not.toHaveBeenCalled();
  });

  it("hands the stored breakdown back when an end is replayed", async () => {
    // The offline queue's promise is that a flush may happen twice. It did, and
    // the second answer carried a total with no calculation behind it — leaving
    // the apps unable to show the citizen why they were charged what they were,
    // which is the one thing a disputed fare turns on.
    const { service, quotes } = endService(
      {
        ...live,
        status: SessionStatus.COMPLETED,
        endAt: new Date("2026-08-06T12:00:00Z"),
        durationMinutes: 120,
        payableAmount: 4130,
        fareBreakdown: QUOTE,
      },
      QUOTE,
    );

    const result: any = await service.end("ses_1", {} as any, ATTENDANT_USER as any, {});

    expect(result.quote).toEqual(QUOTE);
    expect(result.replayed).toBe(true);
    expect(quotes.quote).not.toHaveBeenCalled();
  });

  it("keeps the replayed answer to the shape the first call answers with", async () => {
    const { service } = endService(
      { ...live, status: SessionStatus.COMPLETED, fareBreakdown: QUOTE },
      QUOTE,
    );

    const replay: any = await service.end("ses_1", {} as any, ATTENDANT_USER as any, {});

    // One operation, one shape. Both exits now answer with the fields
    // SESSION_SELECT describes plus the quote and the replay flag: `vehicleId`
    // is read so the fare engine can find a pass and is not answered with, and
    // the zone is no longer selected with its boundary polygon on this path
    // alone.
    expect(replay).toHaveProperty("quote");
    expect(replay).toHaveProperty("replayed", true);
    expect(replay).not.toHaveProperty("vehicleId");
  });

  it("puts the bay back into service", async () => {
    const { service, slots } = endService({ ...live, slotId: "slt_1" }, QUOTE, {
      slot: { id: "slt_1", code: "A-12", zoneId: "zn_1", type: SlotType.CAR, status: SlotStatus.OCCUPIED },
    });

    await service.end("ses_1", {} as any, ATTENDANT_USER as any, {});

    expect(slots.slt_1.status).toBe(SlotStatus.AVAILABLE);
  });

  it("does not reopen a bay that was taken out of service", async () => {
    // `SlotsService.remove` retires any bay with session history to
    // OUT_OF_SERVICE, and a bay can be held RESERVED while a car is in it. The
    // unconditional reset here undid both the moment the car left, and handed
    // a dug-up bay to the next driver.
    const { service, slots } = endService({ ...live, slotId: "slt_1" }, QUOTE, {
      slot: { id: "slt_1", code: "A-12", zoneId: "zn_1", type: SlotType.CAR, status: SlotStatus.OUT_OF_SERVICE },
    });

    await service.end("ses_1", {} as any, ATTENDANT_USER as any, {});

    expect(slots.slt_1.status).toBe(SlotStatus.OUT_OF_SERVICE);
  });

  it("refuses to end a cancelled session", async () => {
    const { service } = endService({ ...live, status: SessionStatus.CANCELLED }, QUOTE);
    await expectRefusal(
      service.end("ses_1", {} as any, ATTENDANT_USER as any, {}),
      "SESSION_NOT_ACTIVE",
    );
  });

  it("refuses an end time before the start", async () => {
    const { service } = endService(live, QUOTE);
    await expectRefusal(
      service.end(
        "ses_1",
        { endedAt: new Date("2026-08-06T09:00:00Z") } as any,
        ATTENDANT_USER as any,
        {},
      ),
      "VALIDATION_FAILED",
    );
  });

  it("prices an overstay session too rather than refusing it", async () => {
    const { service, prisma } = endService({ ...live, status: SessionStatus.OVERSTAY }, QUOTE);
    await service.end("ses_1", {} as any, ATTENDANT_USER as any, {});
    expect(prisma.parkingSession.update).toHaveBeenCalled();
  });
});

describe("cancelling a session", () => {
  it("refuses to cancel a completed session", async () => {
    const { service, prisma } = makeService();
    prisma.parkingSession.findFirst = vi.fn().mockResolvedValue({
      id: "ses_1",
      code: "KMCP-AAA111",
      status: SessionStatus.COMPLETED,
      slotId: null,
      plateNumber: "WB02AB1234",
    });

    // Money has changed hands. Making the session disappear would leave a
    // payment with nothing to point at; the refund path exists for this.
    await expectRefusal(
      service.cancel("ses_1", { reason: "started in error" } as any, ATTENDANT_USER as any, {}),
      "SESSION_NOT_ACTIVE",
    );
  });

  it("zeroes the payable amount when cancelling a live session", async () => {
    const { service, prisma, slots } = makeService({
      slot: { id: "slt_1", code: "A-12", zoneId: "zn_1", type: SlotType.CAR, status: SlotStatus.OCCUPIED },
    });
    prisma.parkingSession.findFirst = vi.fn().mockResolvedValue({
      id: "ses_1",
      code: "KMCP-AAA111",
      status: SessionStatus.ACTIVE,
      slotId: "slt_1",
      plateNumber: "WB02AB1234",
    });
    prisma.parkingSession.update = vi.fn().mockImplementation(({ data }: any) => data);

    await service.cancel(
      "ses_1",
      { reason: "wrong vehicle photographed" } as any,
      ATTENDANT_USER as any,
      {},
    );

    const data = prisma.parkingSession.update.mock.calls[0][0].data;
    expect(data.status).toBe(SessionStatus.CANCELLED);
    expect(data.payableAmount).toBe(0);
    // The bay goes back into service immediately.
    expect(slots.slt_1.status).toBe(SlotStatus.AVAILABLE);
  });

  it("leaves a bay a supervisor had taken out of service alone", async () => {
    const { service, prisma, slots } = makeService({
      slot: { id: "slt_1", code: "A-12", zoneId: "zn_1", type: SlotType.CAR, status: SlotStatus.OUT_OF_SERVICE },
    });
    prisma.parkingSession.findFirst = vi.fn().mockResolvedValue({
      id: "ses_1",
      code: "KMCP-AAA111",
      status: SessionStatus.ACTIVE,
      slotId: "slt_1",
      plateNumber: "WB02AB1234",
    });
    prisma.parkingSession.update = vi.fn().mockImplementation(({ data }: any) => data);

    await service.cancel("ses_1", { reason: "started in error" } as any, ATTENDANT_USER as any, {});

    expect(slots.slt_1.status).toBe(SlotStatus.OUT_OF_SERVICE);
  });
});
