import {
  PrismaClient,
  Prisma,
  IncidentStatus,
  IncidentType,
  PassStatus,
  PaymentMode,
  PaymentStatus,
  ReportStatus,
  SessionSource,
  SessionStatus,
  SettlementStatus,
  ShiftStatus,
  UserStatus,
} from "@prisma/client";
import { SYSTEM_ROLES } from "../src/common/rbac/permissions";

/**
 * Thirty days of operating history, generated relative to the moment it runs.
 *
 * `seed-operations.ts` establishes what the authority *configured* — wards,
 * kerb, operators, staff, rate cards. This establishes what then *happened*:
 * sessions through a working day, the cash they produced, the shifts that
 * collected it, the settlements that moved it to the vendors, and the incidents
 * and passes around the edges.
 *
 * Two properties matter more than the numbers themselves.
 *
 * It is relative. Every timestamp is an offset from `Date.now()`, so a screen
 * asking "what happened today" is answered on the day it is asked rather than
 * on the day someone last ran a seed. The previous history was written with the
 * same intention but upserted with `update: {}`, so re-running it refreshed
 * nothing and the data quietly aged out of every dashboard.
 *
 * It is surgical. Everything created here is either keyed by an id beginning
 * `demo_` or, for sessions, a code beginning `KMCP-H`. `purge()` removes
 * exactly that set and nothing else, so a zone drawn in the portal, a tariff
 * approved by an officer, or a session that came off a real handset survives a
 * regeneration untouched.
 */

const DEMO = "demo_";
const SESSION_PREFIX = "KMCP-H";
const DAYS = 30;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * A fixed-seed PRNG, so the same run produces the same shape every time.
 *
 * `Math.random()` would make every regeneration a different system: yesterday's
 * variance would move to a different attendant and a bug reported against one
 * dataset could not be reproduced against the next. Mulberry32 is four lines
 * and removes that whole class of confusion.
 */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const random = rng(0x4b4d4350); // "KMCP"

const between = (lo: number, hi: number) => lo + random() * (hi - lo);
const intBetween = (lo: number, hi: number) => Math.floor(between(lo, hi + 1));
const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)];
const chance = (p: number) => random() < p;

/**
 * How busy the kerb is at each hour of the day, as a multiplier.
 *
 * Two peaks, because that is what a Kolkata high street actually does: the
 * mid-morning market and office arrival, then the evening shopping and
 * restaurant trade. Overnight is not zero — a few vehicles stay parked.
 */
const HOUR_WEIGHT = [
  0.04, 0.02, 0.02, 0.02, 0.03, 0.08, 0.22, 0.48, 0.78, 0.95,
  1.0, 0.98, 0.9, 0.72, 0.66, 0.7, 0.82, 0.96, 1.0, 0.93,
  0.72, 0.48, 0.26, 0.1,
];

/** Saturday trades hardest, Sunday is quiet, Monday is slow to start. */
const DOW_WEIGHT = [0.72, 0.88, 0.96, 1.0, 1.02, 1.12, 1.18];

/** Roughly the mix a municipal operator sees once UPI is established. */
const PAYMENT_MIX: { mode: PaymentMode; weight: number }[] = [
  { mode: PaymentMode.CASH, weight: 42 },
  { mode: PaymentMode.UPI_QR, weight: 31 },
  { mode: PaymentMode.UPI_INTENT, weight: 13 },
  { mode: PaymentMode.CARD, weight: 8 },
  { mode: PaymentMode.WALLET, weight: 4 },
  { mode: PaymentMode.NETBANKING, weight: 2 },
];

function pickPaymentMode(): PaymentMode {
  const total = PAYMENT_MIX.reduce((s, m) => s + m.weight, 0);
  let roll = random() * total;
  for (const entry of PAYMENT_MIX) {
    roll -= entry.weight;
    if (roll <= 0) return entry.mode;
  }
  return PaymentMode.CASH;
}

/** Midnight local-ish, `daysAgo` days back. Hours are added onto this. */
function dayStart(daysAgo: number): Date {
  const d = new Date(Date.now() - daysAgo * DAY);
  d.setHours(0, 0, 0, 0);
  return d;
}

const PLATE_SERIES = ["WB02", "WB06", "WB08", "WB12", "WB20", "WB24", "WB74"];
const PLATE_LETTERS = ["AA", "AB", "AC", "AD", "AF", "AJ", "AK", "AM", "AP", "AS"];

const MAKES = [
  "Maruti Swift", "Hyundai i20", "Tata Nexon", "Honda City", "Toyota Innova",
  "Mahindra XUV700", "Kia Seltos", "Maruti Baleno", "Hero Splendor", "Honda Activa",
  "TVS Jupiter", "Bajaj Pulsar", "Ashok Leyland Dost", "Tata Ace",
];
const COLOURS = ["White", "Silver", "Grey", "Blue", "Red", "Black", "Beige"];

const CITIZEN_NAMES = [
  "Ananya Sen", "Rohit Mukherjee", "Priya Ghosh", "Arjun Nair", "Debjani Roy",
  "Samir Bose", "Nandini Iyer", "Farhan Ahmed", "Kaushik Dutta", "Meera Pillai",
  "Tanmay Saha", "Ritika Agarwal",
];

/**
 * What a session cost, derived from the tariff that actually applies to it.
 *
 * Deliberately a simplification of `QuoteService` — it has no discounts, passes
 * or holiday multipliers — but it reads the same base, increment, grace and cap
 * from the same rate card, so seeded revenue is consistent with what the API
 * would charge for the same duration rather than an invented number.
 */
function computeFare(
  tariff: {
    baseAmount: number;
    baseMinutes: number;
    incrementAmount: number;
    incrementMinutes: number;
    dailyCapAmount: number | null;
    gracePeriodMin: number;
    taxPercent: Prisma.Decimal;
  },
  minutes: number,
): { gross: number; tax: number; payable: number } {
  const chargeable = Math.max(0, minutes - tariff.gracePeriodMin);
  if (chargeable === 0) return { gross: 0, tax: 0, payable: 0 };

  let gross = tariff.baseAmount;
  if (chargeable > tariff.baseMinutes) {
    const extra = chargeable - tariff.baseMinutes;
    gross += Math.ceil(extra / tariff.incrementMinutes) * tariff.incrementAmount;
  }
  if (tariff.dailyCapAmount) gross = Math.min(gross, tariff.dailyCapAmount);

  const tax = Math.round((gross * Number(tariff.taxPercent)) / 100);
  return { gross, tax, payable: gross + tax };
}

/**
 * Removes the previous generation, and only the previous generation.
 *
 * Order follows the foreign keys inward-out. Anything created through the
 * portal or a handset carries a cuid and a `KMCP-` code without the `H`, so it
 * matches none of these filters and is left alone.
 */
async function purge(prisma: PrismaClient): Promise<void> {
  const demo = { startsWith: DEMO };

  await prisma.settlementLine.deleteMany({ where: { settlementId: demo } });
  await prisma.ledgerEntry.deleteMany({ where: { settlementId: demo } });
  await prisma.settlement.deleteMany({ where: { id: demo } });

  await prisma.receipt.deleteMany({ where: { paymentId: demo } });
  await prisma.payment.deleteMany({ where: { id: demo } });

  await prisma.incident.deleteMany({ where: { id: demo } });
  await prisma.feedback.deleteMany({ where: { id: demo } });

  await prisma.parkingSession.deleteMany({
    where: { OR: [{ id: demo }, { code: { startsWith: SESSION_PREFIX } }] },
  });
  await prisma.shift.deleteMany({ where: { id: demo } });

  await prisma.pass.deleteMany({ where: { id: demo } });
  await prisma.passPlan.deleteMany({ where: { id: demo } });

  await prisma.notification.deleteMany({ where: { id: demo } });
  await prisma.reportJob.deleteMany({ where: { id: demo } });

  await prisma.vehicle.deleteMany({ where: { id: demo } });
  // Attendants before their users — the user is the parent row.
  await prisma.attendant.deleteMany({ where: { id: demo } });
  await prisma.user.deleteMany({ where: { id: demo } });

  await prisma.holiday.deleteMany({ where: { id: demo } });
  await prisma.discount.deleteMany({ where: { id: demo } });
  await prisma.cmsPage.deleteMany({ where: { slug: { startsWith: "kmcp-" } } });
  await prisma.faq.deleteMany({ where: { id: demo } });
  await prisma.banner.deleteMany({ where: { id: demo } });
}

// ---------------------------------------------------------------------------

export async function seedHistory(prisma: PrismaClient): Promise<void> {
  await purge(prisma);
  console.log("✔ previous demonstration history removed");

  // ------------------------------------------------------------- the context

  const zones = await prisma.zone.findMany({
    where: { status: { in: ["OPEN", "EVENT_CLOSURE"] } },
    select: {
      id: true, code: true, name: true, capacity: true,
      centerLat: true, centerLng: true, allowedVehicleTypeIds: true,
    },
    orderBy: { code: "asc" },
  });

  const attendants = await prisma.attendant.findMany({
    where: { isActive: true },
    select: { id: true, vendorId: true, defaultZoneId: true, employeeCode: true, user: { select: { name: true } } },
  });

  const vendors = await prisma.vendor.findMany({
    where: { status: "APPROVED" },
    select: { id: true, orgName: true, commissionPct: true, zones: { select: { zoneId: true } } },
  });

  const tariffs = await prisma.tariff.findMany({
    where: { isPublished: true },
    select: {
      id: true, zoneId: true, vehicleTypeId: true, priority: true,
      baseAmount: true, baseMinutes: true, incrementAmount: true, incrementMinutes: true,
      dailyCapAmount: true, gracePeriodMin: true, taxPercent: true,
    },
  });

  const staff = await prisma.user.findMany({
    where: { role: { in: [SYSTEM_ROLES.SUPER_ADMIN, SYSTEM_ROLES.ADMIN] }, deletedAt: null },
    select: { id: true, name: true },
  });

  if (!zones.length || !attendants.length || !vendors.length || !tariffs.length) {
    throw new Error(
      "seed-history needs zones, attendants, vendors and tariffs to exist first — run the operations seed before this one.",
    );
  }

  /** Which vendor holds the contract for a zone. Falls back to the first. */
  const vendorForZone = new Map<string, (typeof vendors)[number]>();
  for (const vendor of vendors) {
    for (const link of vendor.zones) vendorForZone.set(link.zoneId, vendor);
  }
  const zoneVendor = (zoneId: string) => vendorForZone.get(zoneId) ?? vendors[0];

  /**
   * The rate card that applies, resolved the way the API resolves it: the most
   * specific match wins, so a zone's own card beats the city-wide default.
   */
  function tariffFor(zoneId: string, vehicleTypeId: string) {
    const candidates = tariffs.filter(
      (t) => t.vehicleTypeId === vehicleTypeId && (t.zoneId === zoneId || t.zoneId === null),
    );
    if (!candidates.length) return null;
    return candidates.sort((a, b) => {
      if (a.zoneId && !b.zoneId) return -1;
      if (!a.zoneId && b.zoneId) return 1;
      return b.priority - a.priority;
    })[0];
  }

  // ---------------------------------------------------------- citizens & fleet

  const citizens: { id: string; name: string }[] = [];
  for (const [i, name] of CITIZEN_NAMES.entries()) {
    const id = `${DEMO}usr_cit_${i + 1}`;
    await prisma.user.create({
      data: {
        id,
        name,
        phone: `+9198${String(30_000_000 + i * 137_911).slice(0, 8)}`,
        role: SYSTEM_ROLES.CITIZEN,
        status: i === CITIZEN_NAMES.length - 1 ? UserStatus.SUSPENDED : UserStatus.ACTIVE,
        createdAt: new Date(Date.now() - intBetween(40, 400) * DAY),
      },
    });
    citizens.push({ id, name });
  }
  console.log(`✔ ${citizens.length} citizen accounts`);

  const vehicleTypes = await prisma.vehicleType.findMany({
    where: { isActive: true, code: { in: ["CAR", "TWO_WHEELER", "COMMERCIAL", "EV"] } },
    select: { id: true, code: true },
  });

  /** A believable fleet. Most vehicles are cars; a fifth are two-wheelers. */
  const fleet: { id: string; plate: string; typeId: string }[] = [];
  for (let i = 0; i < 90; i += 1) {
    const type =
      chance(0.62)
        ? vehicleTypes.find((t) => t.code === "CAR")!
        : chance(0.6)
          ? vehicleTypes.find((t) => t.code === "TWO_WHEELER")!
          : pick(vehicleTypes);

    const plate = `${pick(PLATE_SERIES)}${pick(PLATE_LETTERS)}${intBetween(1000, 9999)}`;
    const id = `${DEMO}veh_${i + 1}`;

    // A generated plate can collide with one the operations seed already wrote.
    if (await prisma.vehicle.findUnique({ where: { plateNumber: plate }, select: { id: true } })) {
      continue;
    }

    await prisma.vehicle.create({
      data: {
        id,
        plateNumber: plate,
        vehicleTypeId: type.id,
        makeModel: pick(MAKES),
        colour: pick(COLOURS),
        // Most kerbside parking is by people who never registered with us.
        ownerUserId: chance(0.35) ? pick(citizens).id : null,
        isBlacklisted: chance(0.03),
        createdAt: new Date(Date.now() - intBetween(20, 500) * DAY),
      },
    });
    fleet.push({ id, plate, typeId: type.id });
  }
  console.log(`✔ ${fleet.length} vehicles on the register`);
  // ------------------------------------------------------------ the workforce

  /**
   * Enough attendants to actually staff the kerb.
   *
   * The configuration seed ships six, against 958 bays. That ratio is not a
   * rounding error — it is a demonstration dataset that was never asked to
   * produce plausible occupancy, and it is why the dashboard reported two per
   * cent full with fifteen vehicles in the whole city.
   *
   * A municipal operator staffs roughly one attendant per forty bays. These are
   * generated up to that ratio and prefixed like everything else here, so the
   * authority's real roster replaces them without collision.
   */
  const BAYS_PER_ATTENDANT = 40;
  const totalCapacity = zones.reduce((sum, z) => sum + z.capacity, 0);
  const wanted = Math.max(attendants.length, Math.ceil(totalCapacity / BAYS_PER_ATTENDANT));

  const FIRST = ["Amit","Sourav","Nilanjan","Bikash","Rajesh","Subir","Tapan","Gopal","Ashim","Pradip","Manoj","Swapan","Dipak","Ranjan","Kartik","Sanjay","Biplab","Uttam","Haradhan","Nemai","Sujit","Ashok","Debasish","Prasanta"];
  const LAST = ["Das","Mondal","Ghosh","Naskar","Halder","Pramanik","Sardar","Bag","Maity","Jana","Adhikari","Paul"];

  const roster = [...attendants];
  for (let i = attendants.length; i < wanted; i += 1) {
    const zone = zones[i % zones.length];
    const vendor = zoneVendor(zone.id);
    const userId = `${DEMO}usr_att_${i}`;
    const attendantId = `${DEMO}att_${i}`;

    await prisma.user.create({
      data: {
        id: userId,
        name: `${FIRST[i % FIRST.length]} ${LAST[(i * 7) % LAST.length]}`,
        phone: `+9197${String(40_000_000 + i * 91_337).slice(0, 8)}`,
        role: SYSTEM_ROLES.ATTENDANT,
        status: UserStatus.ACTIVE,
        createdAt: new Date(Date.now() - intBetween(30, 400) * DAY),
      },
    });
    await prisma.attendant.create({
      data: {
        id: attendantId,
        userId,
        vendorId: vendor.id,
        employeeCode: `KMCP-A${String(900 + i).padStart(4, "0")}`,
        defaultZoneId: zone.id,
        createdAt: new Date(Date.now() - intBetween(30, 400) * DAY),
      },
    });

    roster.push({
      id: attendantId,
      vendorId: vendor.id,
      defaultZoneId: zone.id,
      employeeCode: `KMCP-A${String(900 + i).padStart(4, "0")}`,
      user: { name: "" },
    });
  }
  console.log(`✔ ${roster.length} attendants on the roster (${roster.length - attendants.length} generated)`);

  /** Who works which zone. Two or three to a zone, by how big it is. */
  const rosterByZone = new Map<string, typeof roster>();
  for (const zone of zones) rosterByZone.set(zone.id, []);
  for (const [i, person] of roster.entries()) {
    const zoneId = person.defaultZoneId && rosterByZone.has(person.defaultZoneId)
      ? person.defaultZoneId
      : zones[i % zones.length].id;
    rosterByZone.get(zoneId)!.push(person);
  }

  // ------------------------------------------------------ shifts and sessions

  type SessionRow = {
    id: string;
    zoneId: string;
    vendorId: string;
    payable: number;
    mode: PaymentMode;
    endAt: Date;
  };

  /**
   * Written in batches rather than one row at a time.
   *
   * Thirty days of a real city kerb is tens of thousands of sessions and as many
   * payments again. At one round trip per row a seed run takes the better part
   * of an hour; batched it takes about a minute, which is the difference between
   * a dataset anyone can regenerate and one nobody dares touch.
   */
  const CHUNK = 1_000;
  async function flush<T>(rows: T[], write: (batch: T[]) => Promise<unknown>): Promise<void> {
    for (let i = 0; i < rows.length; i += CHUNK) {
      await write(rows.slice(i, i + CHUNK));
    }
  }

  const sessionRows: Prisma.ParkingSessionCreateManyInput[] = [];
  const paymentRows: Prisma.PaymentCreateManyInput[] = [];
  const receiptRows: Prisma.ReceiptCreateManyInput[] = [];
  const shiftRows: Prisma.ShiftCreateManyInput[] = [];

  const completed: SessionRow[] = [];
  let seq = 0;
  let activeCount = 0;

  for (let daysAgo = DAYS - 1; daysAgo >= 0; daysAgo -= 1) {
    const base = dayStart(daysAgo);
    const dayFactor = DOW_WEIGHT[base.getDay()];
    const isToday = daysAgo === 0;

    for (const zone of zones) {
      const crew = rosterByZone.get(zone.id) ?? [];
      if (!crew.length) continue;
      const vendor = zoneVendor(zone.id);

      /**
       * How many vehicles used this kerb today.
       *
       * Expressed as turnover — how many times the average bay is re-let over a
       * working day — because that is how a parking authority reasons about it,
       * and because it makes occupancy fall out of the arithmetic rather than
       * being an accident of how many rows were generated.
       */
      const turnover = between(2.1, 3.4) * dayFactor;
      const demand = Math.round(zone.capacity * turnover);

      // Open each attendant's shift for the day first: sessions carry `shiftId`
      // and a foreign key cannot point at a row that does not exist yet.
      const shifts = crew.map((person, i) => {
        const startHour = i % 2 === 0 ? 7 : 13;
        const startAt = new Date(base.getTime() + startHour * HOUR + intBetween(0, 40) * MINUTE);
        return {
          id: `${DEMO}shf_${daysAgo}_${person.employeeCode}`,
          person,
          startAt,
          endAt: new Date(startAt.getTime() + 8 * HOUR),
          cashExpected: 0,
          digitalTotal: 0,
          sessions: 0,
        };
      }).filter((s) => s.startAt.getTime() <= Date.now());

      if (!shifts.length) continue;

      for (const shift of shifts) {
        const stillOpen = isToday && shift.endAt.getTime() > Date.now();
        shiftRows.push({
          id: shift.id,
          attendantId: shift.person.id,
          vendorId: shift.person.vendorId ?? vendor.id,
          zoneId: zone.id,
          startAt: shift.startAt,
          startLat: zone.centerLat,
          startLng: zone.centerLng,
          status: stillOpen ? ShiftStatus.OPEN : ShiftStatus.CLOSED,
        });
      }

      for (let n = 0; n < demand; n += 1) {
        const vehicle = pick(fleet);
        if (!zone.allowedVehicleTypeIds.includes(vehicle.typeId)) continue;

        const tariff = tariffFor(zone.id, vehicle.typeId);
        if (!tariff) continue;

        // Place the arrival on the day's curve, then hand it to whichever shift
        // was on duty at that hour.
        let startAt: Date | null = null;
        for (let attempt = 0; attempt < 5; attempt += 1) {
          const hour = intBetween(6, 22);
          if (random() > HOUR_WEIGHT[hour]) continue;
          const candidate = new Date(base.getTime() + hour * HOUR + intBetween(0, 59) * MINUTE);
          if (candidate.getTime() > Date.now()) continue;
          startAt = candidate;
          break;
        }
        if (!startAt) continue;

        const onDuty =
          shifts.find((s) => startAt! >= s.startAt && startAt! < s.endAt) ?? shifts[0];

        // Most stays are short; a long tail covers the all-day parkers.
        const durationMinutes = chance(0.7)
          ? intBetween(20, 140)
          : chance(0.72)
            ? intBetween(140, 330)
            : intBetween(330, 600);

        const endAt = new Date(startAt.getTime() + durationMinutes * MINUTE);
        const stillParked = endAt.getTime() > Date.now();

        seq += 1;
        const id = `${DEMO}ses_${seq}`;
        const code = `${SESSION_PREFIX}${String(seq).padStart(6, "0")}`;

        const common = {
          id,
          code,
          zoneId: zone.id,
          vehicleId: vehicle.id,
          plateNumber: vehicle.plate,
          vehicleTypeId: vehicle.typeId,
          vendorId: onDuty.person.vendorId ?? vendor.id,
          attendantId: onDuty.person.id,
          shiftId: onDuty.id,
          tariffId: tariff.id,
          source: SessionSource.ATTENDANT_APP,
          startAt,
          startLat: zone.centerLat + between(-0.0004, 0.0004),
          startLng: zone.centerLng + between(-0.0004, 0.0004),
          createdAt: startAt,
        };

        if (stillParked) {
          // Anything already past four hours is flagged — that is what the
          // enforcement list on the sessions screen is for.
          const elapsed = (Date.now() - startAt.getTime()) / MINUTE;
          sessionRows.push({
            ...common,
            status: elapsed > 240 ? SessionStatus.OVERSTAY : SessionStatus.ACTIVE,
          });
          activeCount += 1;
          continue;
        }

        // A few never complete: the vehicle left before the attendant closed it,
        // or the plate was mistyped and the session was voided.
        if (chance(0.018)) {
          sessionRows.push({
            ...common,
            status: SessionStatus.CANCELLED,
            endAt,
            durationMinutes,
            cancelledReason: pick([
              "Plate entered incorrectly",
              "Vehicle moved before the session was confirmed",
              "Duplicate of an existing session",
            ]),
          });
          continue;
        }

        const fare = computeFare(tariff, durationMinutes);
        const mode = pickPaymentMode();

        sessionRows.push({
          ...common,
          status: SessionStatus.COMPLETED,
          endAt,
          durationMinutes,
          endLat: zone.centerLat + between(-0.0004, 0.0004),
          endLng: zone.centerLng + between(-0.0004, 0.0004),
          grossAmount: fare.gross,
          taxAmount: fare.tax,
          payableAmount: fare.payable,
        });

        onDuty.sessions += 1;
        if (mode === PaymentMode.CASH) onDuty.cashExpected += fare.payable;
        else onDuty.digitalTotal += fare.payable;

        // ------------------------------------------------------- the payment
        const paymentId = `${DEMO}pay_${seq}`;
        const digital = mode !== PaymentMode.CASH;
        const failed = digital && chance(0.028);
        const refunded = !failed && chance(0.012);

        paymentRows.push({
          id: paymentId,
          sessionId: id,
          shiftId: onDuty.id,
          mode,
          amount: fare.payable,
          status: failed
            ? PaymentStatus.FAILED
            : refunded
              ? PaymentStatus.REFUNDED
              : PaymentStatus.CAPTURED,
          idempotencyKey: `${DEMO}idem_${paymentId}`,
          gateway: digital ? "razorpay" : null,
          gatewayOrderId: digital ? `order_${seq}` : null,
          gatewayPaymentId: digital && !failed ? `pay_${seq}` : null,
          signatureVerified: digital && !failed,
          collectedByAttendantId: onDuty.person.id,
          paidAt: failed ? null : endAt,
          refundedAmount: refunded ? fare.payable : 0,
          failureReason: failed ? "Payment declined by the issuing bank" : null,
          createdAt: endAt,
        });

        if (!failed) {
          receiptRows.push({
            paymentId,
            number: `KMC/${endAt.getFullYear()}/${String(seq).padStart(7, "0")}`,
            gstInvoiceNo: `27AABCK1234M1Z${seq % 10}`,
            issuedAt: endAt,
            sentChannels: digital ? ["sms", "email"] : ["sms"],
          });
        }

        if (!failed && !refunded) {
          completed.push({
            id,
            zoneId: zone.id,
            vendorId: onDuty.person.vendorId ?? vendor.id,
            payable: fare.payable,
            mode,
            endAt,
          });
        }
      }

      // ------------------------------------------------------- close the shifts
      for (const shift of shifts) {
        const stillOpen = isToday && shift.endAt.getTime() > Date.now();
        if (stillOpen) continue;

        // Most attendants bank exactly what they took. A few do not, and those
        // are the ones the reconciliation screen exists to catch.
        const short = chance(0.07);
        const cashDeposited = short
          ? Math.max(0, shift.cashExpected - intBetween(2_000, 24_000))
          : shift.cashExpected;
        const verified = daysAgo > 1 && !short;

        const row = shiftRows.find((r) => r.id === shift.id);
        if (!row) continue;
        Object.assign(row, {
          endAt: shift.endAt,
          endLat: zone.centerLat,
          endLng: zone.centerLng,
          sessionsCount: shift.sessions,
          cashExpected: shift.cashExpected,
          cashDeposited,
          digitalTotal: shift.digitalTotal,
          varianceAmount: cashDeposited - shift.cashExpected,
          status: short
            ? ShiftStatus.VARIANCE_FLAGGED
            : verified
              ? ShiftStatus.VERIFIED
              : ShiftStatus.CLOSED,
          verifiedBy: verified ? (staff[0]?.id ?? null) : null,
          verifiedAt: verified ? new Date(shift.endAt.getTime() + 2 * HOUR) : null,
        });
      }
    }
  }

  await flush(shiftRows, (batch) => prisma.shift.createMany({ data: batch }));
  await flush(sessionRows, (batch) => prisma.parkingSession.createMany({ data: batch }));
  await flush(paymentRows, (batch) => prisma.payment.createMany({ data: batch }));
  await flush(receiptRows, (batch) => prisma.receipt.createMany({ data: batch }));

  console.log(
    `✔ ${sessionRows.length} parking sessions across ${DAYS} days ` +
      `(${activeCount} on the kerb now), ${shiftRows.length} shifts, ` +
      `${paymentRows.length} payments`,
  );

  // ------------------------------------------------------------- settlements

  /**
   * One settlement per vendor per week, walked through the workflow so every
   * status on the screen has a row behind it: the oldest weeks are paid, last
   * week is approved and awaiting payout, this week is still being assembled.
   */
  const WEEKS = [
    { start: 28, end: 22, status: SettlementStatus.PAID },
    { start: 21, end: 15, status: SettlementStatus.PAID },
    { start: 14, end: 8, status: SettlementStatus.APPROVED },
    { start: 7, end: 1, status: SettlementStatus.PENDING_APPROVAL },
  ];

  let settlementCount = 0;
  for (const vendor of vendors) {
    for (const [w, week] of WEEKS.entries()) {
      const periodStart = dayStart(week.start);
      const periodEnd = dayStart(week.end);

      const payments = await prisma.payment.findMany({
        where: {
          id: { startsWith: DEMO },
          status: PaymentStatus.CAPTURED,
          paidAt: { gte: periodStart, lt: periodEnd },
          session: { vendorId: vendor.id },
        },
        select: { id: true, amount: true, mode: true },
      });
      if (!payments.length) continue;

      const gross = payments.reduce((s, p) => s + p.amount, 0);
      const cash = payments
        .filter((p) => p.mode === PaymentMode.CASH)
        .reduce((s, p) => s + p.amount, 0);
      const commissionPct = Number(vendor.commissionPct);
      const commission = Math.round((gross * commissionPct) / 100);

      // One rejection in the set, so the reject path has a worked example.
      const rejected = w === 3 && settlementCount % 3 === 1;
      const status = rejected ? SettlementStatus.REJECTED : week.status;
      const settlementId = `${DEMO}stl_${vendor.id.slice(-6)}_${w}`;
      const approvedAt =
        status === SettlementStatus.APPROVED || status === SettlementStatus.PAID
          ? new Date(periodEnd.getTime() + 2 * DAY)
          : null;

      await prisma.settlement.create({
        data: {
          id: settlementId,
          vendorId: vendor.id,
          periodStart,
          periodEnd,
          grossCollected: gross,
          cashCollected: cash,
          digitalCollected: gross - cash,
          commissionAmount: commission,
          vendorShare: commission,
          governmentShare: gross - commission,
          status,
          approvedBy: approvedAt ? (staff[0]?.id ?? null) : null,
          approvedAt,
          rejectionReason: rejected
            ? "Cash deposit slips for two shifts are missing. Re-submit with the bank acknowledgement."
            : null,
          payoutRef:
            status === SettlementStatus.PAID
              ? `SBIN${intBetween(300_000_000, 399_999_999)}`
              : null,
          payoutStatus: status === SettlementStatus.PAID ? "PROCESSED" : null,
          createdAt: new Date(periodEnd.getTime() + DAY),
        },
      });

      await prisma.settlementLine.createMany({
        data: payments.map((p) => ({
          id: `${DEMO}stlline_${p.id.slice(DEMO.length)}`,
          settlementId,
          paymentId: p.id,
          amount: p.amount,
          commission: Math.round((p.amount * commissionPct) / 100),
        })),
      });

      // The ledger is only written once a settlement is approved — before that
      // nothing has been posted, and a preview must not look like a posting.
      if (approvedAt) {
        const postings = [
          { account: "VENDOR_PAYABLE", debit: 0, credit: commission },
          { account: "GOVERNMENT_REVENUE", debit: 0, credit: gross - commission },
        ];
        if (status === SettlementStatus.PAID) {
          postings.push(
            { account: "VENDOR_PAYABLE", debit: commission, credit: 0 },
            { account: "CASH_IN_HAND", debit: 0, credit: commission },
          );
        }
        await prisma.ledgerEntry.createMany({
          data: postings.map((p, i) => ({
            id: `${DEMO}led_${settlementId.slice(DEMO.length)}_${i}`,
            settlementId,
            account: p.account,
            debit: p.debit,
            credit: p.credit,
            refType: "SETTLEMENT",
            refId: settlementId,
            postedAt: approvedAt,
          })),
        });
      }

      settlementCount += 1;
    }
  }
  console.log(`✔ ${settlementCount} settlements with lines and ledger postings`);

  // ---------------------------------------------------------------- incidents

  const INCIDENTS: {
    type: IncidentType;
    description: string;
    status: IncidentStatus;
    resolution?: string;
  }[] = [
    { type: IncidentType.ILLEGAL_PARKING, description: "Vehicle parked across two bays and blocking the loading area outside the market entrance.", status: IncidentStatus.OPEN },
    { type: IncidentType.ILLEGAL_PARKING, description: "Car left on the accessible bay without a permit displayed. Photographed at the kerb.", status: IncidentStatus.IN_PROGRESS },
    { type: IncidentType.VEHICLE_DAMAGE, description: "Wing mirror clipped by a reversing van. Both drivers present, details exchanged.", status: IncidentStatus.RESOLVED, resolution: "Insurance details exchanged on site. No claim raised against the authority." },
    { type: IncidentType.PARKING_DISPUTE, description: "Citizen disputes a four-hour charge and states the vehicle left after ninety minutes.", status: IncidentStatus.IN_PROGRESS },
    { type: IncidentType.PARKING_DISPUTE, description: "Charge contested — the attendant's exit photograph timestamp does not match the citizen's account.", status: IncidentStatus.RESOLVED, resolution: "Exit evidence reviewed. Fare recalculated to two hours and the difference refunded." },
    { type: IncidentType.ACCIDENT, description: "Minor collision at the zone entrance during the evening peak. No injuries reported.", status: IncidentStatus.RESOLVED, resolution: "Traffic police attended. Zone reopened after forty minutes." },
    { type: IncidentType.WRONG_VEHICLE, description: "Session opened against the wrong registration — two plates differ by one character.", status: IncidentStatus.RESOLVED, resolution: "Session cancelled and re-opened against the correct plate. No charge to the citizen." },
    { type: IncidentType.ILLEGAL_PARKING, description: "Commercial vehicle occupying a two-wheeler bay since the morning.", status: IncidentStatus.OPEN },
    { type: IncidentType.OTHER, description: "Tariff board at the zone entrance has been defaced and is no longer legible.", status: IncidentStatus.OPEN },
    { type: IncidentType.OTHER, description: "Kerb markings worn away after resurfacing; bays cannot be identified.", status: IncidentStatus.IN_PROGRESS },
    { type: IncidentType.PARKING_DISPUTE, description: "Citizen reports being charged twice for the same visit.", status: IncidentStatus.RESOLVED, resolution: "Duplicate session found and refunded in full within the same day." },
    { type: IncidentType.WRONG_VEHICLE, description: "Reported vehicle registration does not exist on the register.", status: IncidentStatus.REJECTED, resolution: "No evidence supplied and the plate does not appear in any session. Closed without action." },
    { type: IncidentType.ILLEGAL_PARKING, description: "Repeat offender parking overnight in a bay reserved for the morning market.", status: IncidentStatus.IN_PROGRESS },
    { type: IncidentType.VEHICLE_DAMAGE, description: "Scratch along the driver's side reported on collection. Entry photograph shows it was present on arrival.", status: IncidentStatus.REJECTED, resolution: "Entry evidence shows the damage pre-dated the session. No liability." },
  ];

  for (const [i, incident] of INCIDENTS.entries()) {
    const zone = zones[i % zones.length];
    const createdAt = new Date(Date.now() - intBetween(1, 22) * DAY - intBetween(0, 20) * HOUR);
    const resolved =
      incident.status === IncidentStatus.RESOLVED || incident.status === IncidentStatus.REJECTED;

    await prisma.incident.create({
      data: {
        id: `${DEMO}inc_${i + 1}`,
        reportedById: chance(0.5) ? pick(citizens).id : (attendants[i % attendants.length].id ?? ""),
        zoneId: zone.id,
        type: incident.type,
        description: incident.description,
        status: incident.status,
        assignedTo:
          incident.status === IncidentStatus.OPEN ? null : (staff[i % Math.max(1, staff.length)]?.id ?? null),
        resolutionNote: incident.resolution ?? null,
        resolvedBy: resolved ? (staff[0]?.id ?? null) : null,
        resolvedAt: resolved ? new Date(createdAt.getTime() + intBetween(2, 40) * HOUR) : null,
        createdAt,
      },
    });
  }
  console.log(`✔ ${INCIDENTS.length} incidents across every status`);

  // ------------------------------------------------------------ passes

  const PLANS = [
    { name: "Monthly Resident — Car", type: "CAR", days: 30, price: 180_000 },
    { name: "Monthly Resident — Two-wheeler", type: "TWO_WHEELER", days: 30, price: 70_000 },
    { name: "Quarterly Commuter — Car", type: "CAR", days: 90, price: 480_000 },
    { name: "Weekly Trader — Commercial", type: "COMMERCIAL", days: 7, price: 120_000 },
  ];

  const planIds: string[] = [];
  for (const [i, plan] of PLANS.entries()) {
    const type = vehicleTypes.find((t) => t.code === plan.type);
    if (!type) continue;
    const id = `${DEMO}plan_${i + 1}`;
    await prisma.passPlan.create({
      data: {
        id,
        name: plan.name,
        vehicleTypeId: type.id,
        zoneIds: zones.slice(0, 4).map((z) => z.id),
        durationDays: plan.days,
        price: plan.price,
        isActive: i !== PLANS.length - 1,
      },
    });
    planIds.push(id);
  }

  let passCount = 0;
  for (let i = 0; i < 16; i += 1) {
    const planId = pick(planIds);
    const plan = await prisma.passPlan.findUnique({
      where: { id: planId },
      select: { durationDays: true, vehicleTypeId: true, price: true },
    });
    if (!plan) continue;

    const candidates = fleet.filter((v) => v.typeId === plan.vehicleTypeId);
    if (!candidates.length) continue;
    const vehicle = pick(candidates);

    // Spread the issue dates so some passes have already lapsed and a couple
    // are within a week of doing so — that is what the renewal column is for.
    const issuedDaysAgo = intBetween(2, plan.durationDays + 25);
    const validFrom = new Date(Date.now() - issuedDaysAgo * DAY);
    const validTo = new Date(validFrom.getTime() + plan.durationDays * DAY);
    const expired = validTo.getTime() < Date.now();

    const status = chance(0.06)
      ? PassStatus.PENDING_PAYMENT
      : chance(0.05)
        ? PassStatus.CANCELLED
        : expired
          ? PassStatus.EXPIRED
          : PassStatus.ACTIVE;

    const id = `${DEMO}pass_${i + 1}`;
    await prisma.pass.create({
      data: {
        id,
        userId: pick(citizens).id,
        vehicleId: vehicle.id,
        planId,
        qrCode: `KMCP-PASS-${String(i + 1).padStart(4, "0")}-${intBetween(1000, 9999)}`,
        validFrom,
        validTo,
        status,
        createdAt: validFrom,
      },
    });

    if (status !== PassStatus.PENDING_PAYMENT) {
      const paymentId = `${DEMO}pay_pass_${i + 1}`;
      await prisma.payment.create({
        data: {
          id: paymentId,
          passId: id,
          mode: PaymentMode.UPI_QR,
          amount: plan.price,
          status: PaymentStatus.CAPTURED,
          idempotencyKey: `${DEMO}idem_${paymentId}`,
          gateway: "razorpay",
          gatewayOrderId: `order_pass_${i + 1}`,
          gatewayPaymentId: `pay_pass_${i + 1}`,
          signatureVerified: true,
          paidAt: validFrom,
          createdAt: validFrom,
        },
      });
      await prisma.receipt.create({
        data: {
          paymentId,
          number: `KMC/PASS/${String(i + 1).padStart(6, "0")}`,
          issuedAt: validFrom,
          sentChannels: ["sms", "whatsapp"],
        },
      });
    }
    passCount += 1;
  }
  console.log(`✔ ${planIds.length} pass plans and ${passCount} issued passes`);

  // ------------------------------------------------- pricing calendar

  const HOLIDAYS = [
    { name: "Republic Day", days: -144, multiplier: 0.5, event: false },
    { name: "Holi", days: -172, multiplier: 0.5, event: false },
    { name: "Independence Day", days: -20, multiplier: 0.5, event: false },
    { name: "Durga Puja — Saptami", days: 26, multiplier: 2.0, event: true },
    { name: "Durga Puja — Ashtami", days: 27, multiplier: 2.0, event: true },
    { name: "Kali Puja", days: 46, multiplier: 1.5, event: true },
    { name: "Book Fair — Salt Lake", days: 118, multiplier: 1.5, event: true },
  ];

  for (const [i, holiday] of HOLIDAYS.entries()) {
    const date = new Date(Date.now() + holiday.days * DAY);
    date.setHours(0, 0, 0, 0);
    await prisma.holiday.create({
      data: {
        id: `${DEMO}hol_${i + 1}`,
        date,
        name: holiday.name,
        isEvent: holiday.event,
        zoneIds: holiday.event ? zones.slice(0, 5).map((z) => z.id) : [],
        multiplier: new Prisma.Decimal(holiday.multiplier),
      },
    });
  }

  const DISCOUNTS = [
    { name: "Resident concession", code: "RESIDENT20", percent: 20, flat: null, from: -90, to: 275, active: true },
    { name: "Electric vehicle rebate", code: "EVFREE", percent: 50, flat: null, from: -60, to: 305, active: true },
    { name: "Off-peak morning", code: "EARLY10", percent: 10, flat: null, from: -30, to: 60, active: true },
    { name: "Puja week flat rebate", code: "PUJA25", percent: null, flat: 2_500, from: 20, to: 34, active: true },
    { name: "Launch offer", code: "LAUNCH15", percent: 15, flat: null, from: -210, to: -120, active: false },
  ];

  for (const [i, discount] of DISCOUNTS.entries()) {
    await prisma.discount.create({
      data: {
        id: `${DEMO}dis_${i + 1}`,
        name: discount.name,
        code: discount.code,
        percentOff: discount.percent === null ? null : new Prisma.Decimal(discount.percent),
        flatOff: discount.flat,
        validFrom: new Date(Date.now() + discount.from * DAY),
        validTo: new Date(Date.now() + discount.to * DAY),
        maxUses: 5_000,
        usedCount: discount.active ? intBetween(40, 900) : 0,
        isActive: discount.active,
      },
    });
  }
  console.log(`✔ ${HOLIDAYS.length} calendar dates and ${DISCOUNTS.length} discount rules`);

  // ------------------------------------------------------------ public content

  const PAGES = [
    { slug: "kmcp-about", title: "About municipal parking", body: "<p>The Kolkata Municipal Corporation operates on-street parking across the wards listed in this portal. Every bay is priced by an approved rate card and every charge is receipted.</p>" },
    { slug: "kmcp-how-to-park", title: "How to park", body: "<p>Find a marked bay, wait for the attendant to photograph your registration plate, and keep the receipt sent to your phone. You pay when you leave, for the time you actually stayed.</p>" },
    { slug: "kmcp-tariffs", title: "Tariffs and charges", body: "<p>Rates vary by zone and vehicle type. The first fifteen minutes are free in every zone. A daily cap applies so a long stay is never charged without limit.</p>" },
    { slug: "kmcp-refunds", title: "Refunds and disputes", body: "<p>If you believe a charge is wrong, raise a dispute within seven days. Every session carries a timestamped entry and exit photograph, which is reviewed before a decision.</p>" },
    { slug: "kmcp-contact", title: "Contact the parking cell", body: "<p>Telephone 1800 000 0000 between 08:00 and 20:00, or write to parking@kmc.gov.in. Incidents at the kerb should be reported to the attendant on duty.</p>" },
    { slug: "kmcp-privacy", title: "Privacy notice", body: "<p>We hold your registration number, contact details and the photographs taken at the kerb. Evidence is retained for ninety days and then destroyed. You may request a copy of your data at any time.</p>" },
  ];

  for (const page of PAGES) {
    await prisma.cmsPage.create({
      data: {
        slug: page.slug,
        title: page.title,
        bodyHtml: page.body,
        publishedAt: page.slug === "kmcp-privacy" ? null : new Date(Date.now() - intBetween(3, 90) * DAY),
        updatedBy: staff[0]?.id ?? null,
      },
    });
  }

  const FAQS = [
    { q: "Do I pay before or after parking?", a: "Afterwards. The attendant opens a session when you arrive and closes it when you leave, and you are charged for the time you actually stayed.", c: "Charges" },
    { q: "What happens if I overstay?", a: "Nothing automatic. A session past its expected duration is flagged for the attendant, and an overstay penalty applies only where the rate card sets one.", c: "Charges" },
    { q: "How do I get a receipt?", a: "It is sent to your mobile number as soon as payment is captured. You can also ask the attendant to re-send it.", c: "Charges" },
    { q: "Can I pay by UPI?", a: "Yes. Scan the QR code on the attendant's handset, or pay by card or cash — all three are accepted in every zone.", c: "Payment" },
    { q: "What is a monthly pass?", a: "A pass covers unlimited parking in the listed zones for its duration. It is tied to one registration number and cannot be transferred.", c: "Passes" },
    { q: "Why was my vehicle photographed?", a: "The entry and exit photographs are the evidence behind your charge. They protect you as much as us — a disputed fare is settled by looking at them.", c: "Privacy" },
    { q: "How long are photographs kept?", a: "Ninety days, after which they are destroyed automatically. You may request a copy of anything we hold about you.", c: "Privacy" },
    { q: "A bay was blocked. Who do I tell?", a: "The attendant on duty, who will raise an incident. You can also call the parking cell on 1800 000 0000.", c: "Incidents" },
    { q: "Are the rates the same everywhere?", a: "No. Each zone has an approved rate card, and busy commercial streets are priced higher than residential ones.", c: "Charges" },
  ];

  for (const [i, faq] of FAQS.entries()) {
    await prisma.faq.create({
      data: {
        id: `${DEMO}faq_${i + 1}`,
        question: faq.q,
        answer: faq.a,
        category: faq.c,
        sortOrder: i,
        isActive: true,
      },
    });
  }

  const BANNERS = [
    { title: "Durga Puja parking arrangements", body: "Event rates apply in the central zones from Saptami to Dashami. Plan for longer queues at the kerb.", audience: "ALL", from: 20, to: 34, active: true },
    { title: "UPI is now accepted in every zone", body: "Scan the attendant's QR code to pay. Cash and card continue to be accepted.", audience: "CITIZEN", from: -25, to: 40, active: true },
    { title: "Settlement cycle moves to weekly", body: "From the first of next month, vendor settlements are generated every Monday rather than fortnightly.", audience: "VENDOR", from: -8, to: 30, active: true },
    { title: "Monsoon closures", body: "Zones on low-lying streets may close at short notice during heavy rain. Check the app before travelling.", audience: "CITIZEN", from: -120, to: -30, active: false },
  ];

  for (const [i, banner] of BANNERS.entries()) {
    await prisma.banner.create({
      data: {
        id: `${DEMO}ban_${i + 1}`,
        title: banner.title,
        body: banner.body,
        audience: banner.audience,
        startAt: new Date(Date.now() + banner.from * DAY),
        endAt: new Date(Date.now() + banner.to * DAY),
        isActive: banner.active,
      },
    });
  }
  console.log(`✔ ${PAGES.length} pages, ${FAQS.length} FAQs and ${BANNERS.length} banners`);

  // ---------------------------------------------------------- reports & alerts

  const REPORTS: { type: string; status: ReportStatus; hoursAgo: number; error?: string }[] = [
    { type: "revenue-by-zone", status: ReportStatus.COMPLETED, hoursAgo: 3 },
    { type: "collection-summary", status: ReportStatus.COMPLETED, hoursAgo: 26 },
    { type: "vendor-settlement", status: ReportStatus.COMPLETED, hoursAgo: 50 },
    { type: "session-log", status: ReportStatus.COMPLETED, hoursAgo: 74 },
    { type: "shift-reconciliation", status: ReportStatus.RUNNING, hoursAgo: 0 },
    { type: "occupancy-utilisation", status: ReportStatus.QUEUED, hoursAgo: 0 },
    { type: "attendant-performance", status: ReportStatus.FAILED, hoursAgo: 98, error: "The selected period contains no completed shifts." },
  ];

  for (const [i, report] of REPORTS.entries()) {
    const createdAt = new Date(Date.now() - report.hoursAgo * HOUR - intBetween(0, 50) * MINUTE);
    await prisma.reportJob.create({
      data: {
        id: `${DEMO}rpt_${i + 1}`,
        type: report.type,
        params: {
          from: dayStart(30).toISOString(),
          to: new Date().toISOString(),
          format: "csv",
        },
        status: report.status,
        requestedById: staff[i % Math.max(1, staff.length)]?.id ?? staff[0]?.id ?? "",
        error: report.error ?? null,
        createdAt,
        completedAt:
          report.status === ReportStatus.COMPLETED || report.status === ReportStatus.FAILED
            ? new Date(createdAt.getTime() + intBetween(4, 90) * 1000)
            : null,
      },
    });
  }
  console.log(`✔ ${REPORTS.length} report jobs`);

  // In-app alerts for the officers who sign in to the portal. The delivery
  // channels — SMS, WhatsApp, email — are a separate module that does not exist
  // yet, so everything written here is IN_APP and honestly marked SENT.
  const ALERTS = [
    { template: "shift.variance", title: "Cash variance on a closed shift", body: "A shift closed short against its expected cash. Reconcile before verifying." },
    { template: "settlement.pending", title: "Settlement awaiting your approval", body: "A weekly settlement has been submitted and is waiting on an officer." },
    { template: "vendor.application", title: "New vendor application", body: "An operator has applied and their KYC documents are ready for review." },
    { template: "zone.occupancy", title: "Zone approaching capacity", body: "Occupancy has passed ninety per cent for over an hour." },
    { template: "incident.opened", title: "Incident reported at the kerb", body: "An illegal parking incident has been raised and is unassigned." },
    { template: "session.overstay", title: "Vehicles past expected duration", body: "Several sessions have been flagged as overstaying." },
    { template: "tariff.published", title: "Rate card published", body: "A new tariff version is live and enforceable at the kerb." },
    { template: "report.ready", title: "Your report is ready", body: "The revenue-by-zone export has finished and can be downloaded." },
  ];

  let alertCount = 0;
  for (const person of staff) {
    for (const [i, alert] of ALERTS.entries()) {
      const createdAt = new Date(Date.now() - intBetween(1, 96) * HOUR);
      await prisma.notification.create({
        data: {
          id: `${DEMO}ntf_${person.id.slice(-6)}_${i}`,
          userId: person.id,
          channel: "IN_APP",
          template: alert.template,
          payload: { title: alert.title, body: alert.body },
          status: "SENT",
          sentAt: createdAt,
          readAt: i > 3 ? new Date(createdAt.getTime() + 2 * HOUR) : null,
          createdAt,
        },
      });
      alertCount += 1;
    }
  }
  console.log(`✔ ${alertCount} in-app notifications`);
}
