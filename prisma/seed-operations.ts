import { readFileSync } from "node:fs";
import { SYSTEM_ROLES } from "../src/common/rbac/permissions";
import { join } from "node:path";
import {
  PrismaClient,
  Prisma,
  SessionSource,
  SessionStatus,
  SlotStatus,
  SlotType,
  UserStatus,
  VendorStatus,
  ZoneStatus,
} from "@prisma/client";
import * as bcrypt from "bcryptjs";

/**
 * Operational seed data, loaded from `prisma/data/*.json`.
 *
 * Nothing is hard-coded here on purpose. When the authority supplies its real
 * ward list, street register, vendor contracts and approved tariffs, those
 * files are replaced and this file does not change — the same loader takes an
 * export from KMC's own records without anyone editing TypeScript to do it.
 *
 * Every write is an upsert keyed on a natural business key — a ward code, a
 * zone code, an employee code, a plate number — so this can be run repeatedly,
 * and real data can arrive alongside demonstration data without colliding.
 */

const DATA_DIR = join(__dirname, "data");

function load<T>(file: string): T[] {
  try {
    return JSON.parse(readFileSync(join(DATA_DIR, file), "utf8")) as T[];
  } catch (error) {
    // Name the file. A bare JSON parse error three frames deep tells whoever
    // swapped in the authority's export nothing about which one is malformed.
    throw new Error(`Could not read seed data from prisma/data/${file} — ${String(error)}`);
  }
}

interface WardRow {
  id: string;
  code: string;
  name: string;
}
interface StreetRow {
  id: string;
  wardId: string;
  name: string;
}
interface ZoneRow {
  id: string;
  code: string;
  name: string;
  wardId: string;
  streetId: string;
  lat: number;
  lng: number;
  capacity: number;
  types: SlotType[];
  open: string;
  close: string;
  status: ZoneStatus;
  closureReason?: string | null;
}
interface VendorRow {
  id: string;
  userId: string;
  orgName: string;
  contact: string;
  phone: string;
  email: string;
  gstin: string | null;
  pan: string;
  commission: number;
  status: VendorStatus;
  zones: string[];
}
interface AttendantRow {
  id: string;
  vendorId: string;
  code: string;
  name: string;
  phone: string;
  zoneId: string;
}
interface TariffRow {
  id: string;
  name: string;
  zoneId: string | null;
  vehicleTypeId: SlotType;
  baseAmount: number;
  baseMinutes: number;
  incrementAmount: number;
  incrementMinutes: number;
  dailyCap: number;
  grace: number;
  overstay: number;
  priority: number;
}
interface VehicleRow {
  plate: string;
  type: SlotType;
  make: string;
  colour: string;
}
interface SessionRow {
  code: string;
  plate: string;
  zoneId: string;
  attendantId: string;
  vendorId: string;
  startedMinutesAgo: number;
  endedMinutesAgo: number | null;
}

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);

/**
 * A rectangle roughly `metres` across, centred on a point.
 *
 * Real boundaries come from a survey; these exist so the geo-fence has
 * something to test against and the map draws a shape rather than a bare pin.
 * GeoJSON order is [lng, lat], which is the opposite of how everyone says it.
 */
function boundaryAround(lat: number, lng: number, metres = 60) {
  const dLat = metres / 111_320;
  const dLng = metres / (111_320 * Math.cos((lat * Math.PI) / 180));
  return {
    type: "Polygon",
    coordinates: [
      [
        [lng - dLng, lat - dLat],
        [lng + dLng, lat - dLat],
        [lng + dLng, lat + dLat],
        [lng - dLng, lat + dLat],
        [lng - dLng, lat - dLat],
      ],
    ],
  };
}

export async function seedOperations(prisma: PrismaClient): Promise<void> {
  const passwordHash = await bcrypt.hash(process.env.SEED_PASSWORD ?? "kmcp-demo-2026", 12);

  const wards = load<WardRow>("wards.json");
  const streets = load<StreetRow>("streets.json");
  const zones = load<ZoneRow>("zones.json");
  const vendors = load<VendorRow>("vendors.json");
  const attendants = load<AttendantRow>("attendants.json");
  const tariffs = load<TariffRow>("tariffs.json");
  const vehicles = load<VehicleRow>("vehicles.json");
  const sessions = load<SessionRow>("sessions.json");

  for (const ward of wards) {
    await prisma.ward.upsert({
      where: { code: ward.code },
      create: ward,
      update: { name: ward.name },
    });
  }
  console.log(`✔ ${wards.length} wards`);

  for (const street of streets) {
    await prisma.street.upsert({
      where: { id: street.id },
      create: street,
      update: { name: street.name },
    });
  }
  console.log(`✔ ${streets.length} streets`);

  // Keyed on `code`: a zone created through the portal already owns that code,
  // and the authority thinks in codes rather than database ids. Where one
  // exists, its name, capacity and status are left exactly as they are — only a
  // missing boundary is filled in, derived from that row's own centre, or the
  // geo-fence would end up somewhere the zone is not.
  const zoneId = new Map<string, string>();
  for (const zone of zones) {
    const existing = await prisma.zone.findUnique({
      where: { code: zone.code },
      select: { id: true, centerLat: true, centerLng: true, boundary: true },
    });

    if (existing) {
      if (existing.boundary === null) {
        await prisma.zone.update({
          where: { id: existing.id },
          data: {
            boundary: boundaryAround(
              existing.centerLat,
              existing.centerLng,
            ) as unknown as Prisma.InputJsonValue,
          },
        });
      }
      zoneId.set(zone.id, existing.id);
      continue;
    }

    const created = await prisma.zone.create({
      data: {
        id: zone.id,
        code: zone.code,
        name: zone.name,
        wardId: zone.wardId,
        streetId: zone.streetId,
        centerLat: zone.lat,
        centerLng: zone.lng,
        boundary: boundaryAround(zone.lat, zone.lng) as unknown as Prisma.InputJsonValue,
        capacity: zone.capacity,
        allowedVehicleTypeIds: zone.types,
        openTime: zone.open,
        closeTime: zone.close,
        status: zone.status,
        closureReason: zone.closureReason ?? null,
      },
      select: { id: true },
    });
    zoneId.set(zone.id, created.id);
  }
  console.log(`✔ ${zones.length} zones`);

  // Bays for the first few zones only. Realistic: capacity is priced long
  // before every bay on the kerb has been painted and recorded.
  let bays = 0;
  const zonesWithBays = zones.slice(0, 6);
  for (const zone of zonesWithBays) {
    const count = Math.min(20, Math.floor(zone.capacity / 4));
    for (let n = 1; n <= count; n += 1) {
      const code = `B${String(n).padStart(3, "0")}`;
      await prisma.slot.upsert({
        where: { zoneId_code: { zoneId: zoneId.get(zone.id)!, code } },
        create: {
          zoneId: zoneId.get(zone.id)!,
          code,
          type: n % 5 === 0 ? SlotType.TWO_WHEELER : SlotType.CAR,
          status:
            zone.status === ZoneStatus.MAINTENANCE
              ? SlotStatus.OUT_OF_SERVICE
              : SlotStatus.AVAILABLE,
        },
        update: {},
      });
      bays += 1;
    }
  }
  console.log(`✔ ${bays} bays across ${zonesWithBays.length} zones`);

  for (const vendor of vendors) {
    await prisma.user.upsert({
      where: { id: vendor.userId },
      create: {
        id: vendor.userId,
        name: vendor.contact,
        email: vendor.email,
        phone: vendor.phone,
        role: SYSTEM_ROLES.VENDOR,
        status: UserStatus.ACTIVE,
        passwordHash,
      },
      update: { passwordHash },
    });

    await prisma.vendor.upsert({
      where: { id: vendor.id },
      create: {
        id: vendor.id,
        userId: vendor.userId,
        orgName: vendor.orgName,
        contactName: vendor.contact,
        contactPhone: vendor.phone,
        gstin: vendor.gstin,
        pan: vendor.pan,
        bankAccountName: vendor.orgName,
        bankAccountNo: `50100${vendor.id.slice(-6).toUpperCase()}`,
        bankIfsc: "HDFC0000123",
        commissionPct: new Prisma.Decimal(vendor.commission),
        status: vendor.status,
        approvedAt: vendor.status === VendorStatus.APPROVED ? minutesAgo(60 * 24 * 30) : null,
      },
      update: { status: vendor.status, commissionPct: new Prisma.Decimal(vendor.commission) },
    });

    for (const key of vendor.zones) {
      const zid = zoneId.get(key);
      if (!zid) continue;
      await prisma.vendorZone.upsert({
        where: { vendorId_zoneId: { vendorId: vendor.id, zoneId: zid } },
        create: { vendorId: vendor.id, zoneId: zid },
        update: { endedAt: null },
      });
    }
  }
  console.log(`✔ ${vendors.length} vendors with zone assignments`);

  for (const attendant of attendants) {
    const userId = `usr_${attendant.id}`;
    await prisma.user.upsert({
      where: { id: userId },
      create: {
        id: userId,
        name: attendant.name,
        phone: attendant.phone,
        role: SYSTEM_ROLES.ATTENDANT,
        status: UserStatus.ACTIVE,
        passwordHash,
      },
      update: { passwordHash },
    });

    await prisma.attendant.upsert({
      where: { employeeCode: attendant.code },
      create: {
        id: attendant.id,
        userId,
        vendorId: attendant.vendorId,
        employeeCode: attendant.code,
        defaultZoneId: zoneId.get(attendant.zoneId),
      },
      update: { defaultZoneId: zoneId.get(attendant.zoneId) },
    });
  }
  console.log(`✔ ${attendants.length} attendants`);

  const effectiveFrom = new Date("2026-04-01T00:00:00Z");
  for (const tariff of tariffs) {
    await prisma.tariff.upsert({
      where: { id: tariff.id },
      create: {
        id: tariff.id,
        name: tariff.name,
        zoneId: tariff.zoneId ? (zoneId.get(tariff.zoneId) ?? null) : null,
        vehicleTypeId: tariff.vehicleTypeId,
        baseAmount: tariff.baseAmount,
        baseMinutes: tariff.baseMinutes,
        incrementAmount: tariff.incrementAmount,
        incrementMinutes: tariff.incrementMinutes,
        dailyCapAmount: tariff.dailyCap,
        gracePeriodMin: tariff.grace,
        overstayPenalty: tariff.overstay,
        taxPercent: new Prisma.Decimal(18),
        effectiveFrom,
        isPublished: true,
        priority: tariff.priority,
      },
      update: { isPublished: true },
    });
  }
  console.log(`✔ ${tariffs.length} published tariffs`);

  for (const vehicle of vehicles) {
    await prisma.vehicle.upsert({
      where: { plateNumber: vehicle.plate },
      create: {
        plateNumber: vehicle.plate,
        vehicleTypeId: vehicle.type,
        makeModel: vehicle.make,
        colour: vehicle.colour,
      },
      update: {},
    });
  }
  console.log(`✔ ${vehicles.length} vehicles`);

  for (const s of sessions) {
    const vehicle = await prisma.vehicle.findUnique({ where: { plateNumber: s.plate } });
    const zid = zoneId.get(s.zoneId);
    if (!vehicle || !zid) continue;

    const zone = zones.find((z) => z.id === s.zoneId);
    const startAt = minutesAgo(s.startedMinutesAgo);
    const endAt = s.endedMinutesAgo === null ? null : minutesAgo(s.endedMinutesAgo);
    const durationMinutes = endAt ? s.startedMinutesAgo - s.endedMinutesAgo! : null;

    // Indicative only. A real fare comes from the quote service when a session
    // is ended through the API — these exist so closed sessions do not render as
    // blanks, and should not be read as authoritative revenue.
    const hours = durationMinutes ? Math.max(1, Math.ceil(durationMinutes / 60)) : 0;
    const gross = durationMinutes ? 2000 + Math.max(0, hours - 1) * 1500 : null;
    const tax = gross ? Math.round(gross * 0.18) : null;

    await prisma.parkingSession.upsert({
      where: { code: s.code },
      create: {
        code: s.code,
        zoneId: zid,
        vehicleId: vehicle.id,
        plateNumber: s.plate,
        vehicleTypeId: vehicle.vehicleTypeId,
        vendorId: s.vendorId,
        attendantId: s.attendantId,
        status: endAt ? SessionStatus.COMPLETED : SessionStatus.ACTIVE,
        source: SessionSource.ATTENDANT_APP,
        startAt,
        endAt,
        durationMinutes,
        startLat: zone?.lat,
        startLng: zone?.lng,
        grossAmount: gross,
        taxAmount: tax ?? 0,
        payableAmount: gross && tax ? gross + tax : null,
      },
      update: {},
    });
  }
  console.log(`✔ ${sessions.length} parking sessions`);
}
