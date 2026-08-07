import {
  PrismaClient,
  Prisma,
  SessionSource,
  SessionStatus,
  SlotStatus,
  SlotType,
  UserRole,
  UserStatus,
  VendorStatus,
  ZoneStatus,
} from "@prisma/client";
import * as bcrypt from "bcryptjs";

/**
 * Operational demonstration data: real Kolkata geography, kerb that could
 * plausibly exist, and enough sessions to make every screen show something.
 *
 * Deliberately not random. Ids are stable and every write is an upsert, so this
 * can be run repeatedly, and so the authority's real ward and street data can
 * later replace these rows without colliding with them.
 *
 * The coordinates are genuine — Park Street really is at 22.5535, 88.3520 — so
 * the map screens and the geo-fence behave the way they will in the field
 * rather than putting the whole city on one pin.
 */

const WARDS = [
  { id: "wrd_045", code: "W045", name: "Ward 45 — Esplanade & New Market" },
  { id: "wrd_063", code: "W063", name: "Ward 63 — Park Street" },
  { id: "wrd_064", code: "W064", name: "Ward 64 — Ballygunge" },
  { id: "wrd_069", code: "W069", name: "Ward 69 — Gariahat" },
  { id: "wrd_088", code: "W088", name: "Ward 88 — Lake & Southern Avenue" },
];

const STREETS = [
  { id: "str_lindsay", wardId: "wrd_045", name: "Lindsay Street" },
  { id: "str_chowringhee", wardId: "wrd_045", name: "Jawaharlal Nehru Road (Chowringhee)" },
  { id: "str_park", wardId: "wrd_063", name: "Park Street (Mother Teresa Sarani)" },
  { id: "str_camac", wardId: "wrd_063", name: "Camac Street (Abanindranath Tagore Sarani)" },
  { id: "str_russell", wardId: "wrd_063", name: "Russell Street" },
  { id: "str_shakespeare", wardId: "wrd_064", name: "Shakespeare Sarani" },
  { id: "str_ballygunge", wardId: "wrd_064", name: "Ballygunge Circular Road" },
  { id: "str_gariahat", wardId: "wrd_069", name: "Gariahat Road" },
  { id: "str_hindustan", wardId: "wrd_069", name: "Hindustan Park" },
  { id: "str_rashbehari", wardId: "wrd_088", name: "Rashbehari Avenue" },
  { id: "str_southern", wardId: "wrd_088", name: "Southern Avenue" },
];

const ALL_LIGHT: SlotType[] = [SlotType.TWO_WHEELER, SlotType.CAR, SlotType.EV];
const WITH_COMMERCIAL: SlotType[] = [...ALL_LIGHT, SlotType.THREE_WHEELER, SlotType.COMMERCIAL];

const ZONES = [
  {
    id: "zn_pks_01", code: "PKS-01", name: "Park Street (South Kerb)",
    wardId: "wrd_063", streetId: "str_park",
    lat: 22.5535, lng: 88.352, capacity: 120,
    types: WITH_COMMERCIAL, open: "07:00", close: "23:00", status: ZoneStatus.OPEN,
  },
  {
    id: "zn_pks_02", code: "PKS-02", name: "Park Street (North Kerb)",
    wardId: "wrd_063", streetId: "str_park",
    lat: 22.5541, lng: 88.3527, capacity: 96,
    types: ALL_LIGHT, open: "07:00", close: "23:00", status: ZoneStatus.OPEN,
  },
  {
    id: "zn_cam_01", code: "CAM-01", name: "Camac Street",
    wardId: "wrd_063", streetId: "str_camac",
    lat: 22.5448, lng: 88.352, capacity: 84,
    types: ALL_LIGHT, open: "08:00", close: "22:00", status: ZoneStatus.OPEN,
  },
  {
    id: "zn_rus_01", code: "RUS-01", name: "Russell Street",
    wardId: "wrd_063", streetId: "str_russell",
    lat: 22.552, lng: 88.353, capacity: 48,
    types: ALL_LIGHT, open: "08:00", close: "21:00", status: ZoneStatus.MAINTENANCE,
  },
  {
    id: "zn_shk_01", code: "SHK-01", name: "Shakespeare Sarani",
    wardId: "wrd_064", streetId: "str_shakespeare",
    lat: 22.54, lng: 88.356, capacity: 72,
    types: WITH_COMMERCIAL, open: "07:00", close: "22:00", status: ZoneStatus.OPEN,
  },
  {
    id: "zn_bly_01", code: "BLY-01", name: "Ballygunge Circular Road",
    wardId: "wrd_064", streetId: "str_ballygunge",
    lat: 22.5305, lng: 88.3635, capacity: 60,
    types: ALL_LIGHT, open: "08:00", close: "21:00", status: ZoneStatus.OPEN,
  },
  {
    id: "zn_gar_01", code: "GAR-01", name: "Gariahat Market",
    wardId: "wrd_069", streetId: "str_gariahat",
    lat: 22.517, lng: 88.366, capacity: 140,
    types: WITH_COMMERCIAL, open: "06:00", close: "23:00", status: ZoneStatus.OPEN,
  },
  {
    id: "zn_hin_01", code: "HIN-01", name: "Hindustan Park",
    wardId: "wrd_069", streetId: "str_hindustan",
    lat: 22.514, lng: 88.362, capacity: 40,
    types: ALL_LIGHT, open: "08:00", close: "20:00", status: ZoneStatus.OPEN,
  },
  {
    id: "zn_ras_01", code: "RAS-01", name: "Rashbehari Avenue",
    wardId: "wrd_088", streetId: "str_rashbehari",
    lat: 22.515, lng: 88.352, capacity: 88,
    types: ALL_LIGHT, open: "07:00", close: "22:00", status: ZoneStatus.OPEN,
  },
  {
    id: "zn_new_01", code: "NEW-01", name: "New Market (Lindsay Street)",
    wardId: "wrd_045", streetId: "str_lindsay",
    lat: 22.5622, lng: 88.352, capacity: 110,
    types: WITH_COMMERCIAL, open: "09:00", close: "21:00", status: ZoneStatus.OPEN,
  },
];

const VENDORS = [
  {
    id: "ven_metro", userId: "usr_ven_metro",
    orgName: "Metro Kerb Management Pvt Ltd",
    contact: "Arindam Ghosh", phone: "+919830440001", email: "ops@metrokerb.in",
    gstin: "19AABCM1234C1Z8", pan: "AABCM1234C",
    commission: 18, status: VendorStatus.APPROVED,
    zones: ["zn_pks_01", "zn_pks_02", "zn_cam_01", "zn_rus_01"],
  },
  {
    id: "ven_orbit", userId: "usr_ven_orbit",
    orgName: "Orbit Parking Services",
    contact: "Sabina Rahman", phone: "+919830440002", email: "ops@orbitparking.in",
    gstin: "19AAFCO5678D1ZK", pan: "AAFCO5678D",
    commission: 16.5, status: VendorStatus.APPROVED,
    zones: ["zn_gar_01", "zn_hin_01", "zn_ras_01"],
  },
  {
    id: "ven_civic", userId: "usr_ven_civic",
    orgName: "Civic Mobility Contractors",
    contact: "Tapan Mitra", phone: "+919830440003", email: "ops@civicmobility.in",
    gstin: null, pan: "AACCC9012E",
    // Left PENDING on purpose: the KYC gate is a real workflow and the portal
    // should have something sitting in it to demonstrate.
    commission: 20, status: VendorStatus.PENDING,
    zones: [],
  },
];

const ATTENDANTS = [
  { id: "att_001", vendorId: "ven_metro", code: "MTR-101", name: "Subir Das", phone: "+919831550101", zoneId: "zn_pks_01" },
  { id: "att_002", vendorId: "ven_metro", code: "MTR-102", name: "Rekha Paul", phone: "+919831550102", zoneId: "zn_pks_02" },
  { id: "att_003", vendorId: "ven_metro", code: "MTR-103", name: "Imran Sheikh", phone: "+919831550103", zoneId: "zn_cam_01" },
  { id: "att_004", vendorId: "ven_orbit", code: "ORB-201", name: "Bapi Sardar", phone: "+919831550201", zoneId: "zn_gar_01" },
  { id: "att_005", vendorId: "ven_orbit", code: "ORB-202", name: "Jhuma Mondal", phone: "+919831550202", zoneId: "zn_hin_01" },
  { id: "att_006", vendorId: "ven_orbit", code: "ORB-203", name: "Kartik Roy", phone: "+919831550203", zoneId: "zn_ras_01" },
];

/** Amounts are paise throughout. ₹20.00 = 2000. */
const TARIFFS = [
  {
    id: "trf_car_city", name: "City Standard — Car", zoneId: null,
    vehicleTypeId: SlotType.CAR,
    baseAmount: 2000, baseMinutes: 60, incrementAmount: 1500, incrementMinutes: 60,
    dailyCap: 15000, grace: 10, overstay: 5000, priority: 1,
  },
  {
    id: "trf_2w_city", name: "City Standard — Two Wheeler", zoneId: null,
    vehicleTypeId: SlotType.TWO_WHEELER,
    baseAmount: 1000, baseMinutes: 60, incrementAmount: 500, incrementMinutes: 60,
    dailyCap: 6000, grace: 10, overstay: 2500, priority: 1,
  },
  {
    id: "trf_ev_city", name: "City Standard — Electric Vehicle", zoneId: null,
    vehicleTypeId: SlotType.EV,
    // Deliberately cheaper: the incentive is policy, not a rounding artefact.
    baseAmount: 1500, baseMinutes: 60, incrementAmount: 1000, incrementMinutes: 60,
    dailyCap: 10000, grace: 15, overstay: 3000, priority: 1,
  },
  {
    id: "trf_car_park", name: "Park Street Premium — Car", zoneId: "zn_pks_01",
    vehicleTypeId: SlotType.CAR,
    // Zone-specific beats city-wide, which is what the priority rule is for.
    baseAmount: 3000, baseMinutes: 60, incrementAmount: 2500, incrementMinutes: 60,
    dailyCap: 25000, grace: 5, overstay: 7500, priority: 10,
  },
  {
    id: "trf_car_gar", name: "Gariahat Market — Car", zoneId: "zn_gar_01",
    vehicleTypeId: SlotType.CAR,
    baseAmount: 2500, baseMinutes: 60, incrementAmount: 2000, incrementMinutes: 60,
    dailyCap: 18000, grace: 10, overstay: 6000, priority: 10,
  },
];

const PLATES = [
  { plate: "WB02AB1234", type: SlotType.CAR, make: "Maruti Swift", colour: "White" },
  { plate: "WB06C4455", type: SlotType.CAR, make: "Hyundai i20", colour: "Silver" },
  { plate: "WB20K9911", type: SlotType.TWO_WHEELER, make: "Honda Activa", colour: "Grey" },
  { plate: "WB24T7788", type: SlotType.CAR, make: "Tata Nexon EV", colour: "Blue" },
  { plate: "WB19E3322", type: SlotType.EV, make: "MG ZS EV", colour: "White" },
  { plate: "WB02AJ8080", type: SlotType.CAR, make: "Toyota Innova", colour: "Black" },
  { plate: "WB74M2211", type: SlotType.TWO_WHEELER, make: "TVS Jupiter", colour: "Red" },
  { plate: "WB12F6543", type: SlotType.CAR, make: "Honda City", colour: "Silver" },
];

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);

/**
 * A rectangle roughly `metres` across, centred on the zone.
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

  for (const ward of WARDS) {
    await prisma.ward.upsert({
      where: { id: ward.id },
      create: ward,
      update: { name: ward.name },
    });
  }
  console.log(`✔ ${WARDS.length} wards`);

  for (const street of STREETS) {
    await prisma.street.upsert({
      where: { id: street.id },
      create: street,
      update: { name: street.name },
    });
  }
  console.log(`✔ ${STREETS.length} streets`);

  // Keyed on `code`, not on the seed's own id: a zone created through the
  // portal already owns that code, and the authority thinks in codes. Where one
  // exists, its name, capacity and status are left exactly as they were — only
  // the boundary is filled in, so the map and geo-fence have a shape to work
  // with. The real ids are carried forward for everything that references them.
  const zoneId = new Map<string, string>();
  for (const zone of ZONES) {
    const existing = await prisma.zone.findUnique({
      where: { code: zone.code },
      select: { id: true, centerLat: true, centerLng: true, boundary: true },
    });

    if (existing) {
      // Someone already owns this code — leave their name, capacity and status
      // alone. Only fill a missing boundary, and derive it from *their* centre,
      // never from the seed's, or the geo-fence would sit somewhere else.
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
        closureReason:
          zone.status === ZoneStatus.MAINTENANCE ? "Resurfacing works until further notice" : null,
      },
      select: { id: true },
    });
    zoneId.set(zone.id, created.id);
  }
  console.log(`✔ ${ZONES.length} zones`);

  // Bays for a subset of zones. Not every zone has its kerb mapped yet, which
  // is realistic — capacity is priced long before the bays are painted.
  let bays = 0;
  for (const zone of ZONES.slice(0, 6)) {
    const count = Math.min(20, Math.floor(zone.capacity / 4));
    for (let n = 1; n <= count; n += 1) {
      const code = `B${String(n).padStart(3, "0")}`;
      await prisma.slot.upsert({
        where: { zoneId_code: { zoneId: zoneId.get(zone.id)!, code } },
        create: {
          zoneId: zoneId.get(zone.id)!,
          code,
          type: n % 5 === 0 ? SlotType.TWO_WHEELER : SlotType.CAR,
          status: zone.status === ZoneStatus.MAINTENANCE ? SlotStatus.OUT_OF_SERVICE : SlotStatus.AVAILABLE,
        },
        update: {},
      });
      bays += 1;
    }
  }
  console.log(`✔ ${bays} bays across ${Math.min(6, ZONES.length)} zones`);

  for (const vendor of VENDORS) {
    await prisma.user.upsert({
      where: { id: vendor.userId },
      create: {
        id: vendor.userId,
        name: vendor.contact,
        email: vendor.email,
        phone: vendor.phone,
        role: UserRole.VENDOR,
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
  console.log(`✔ ${VENDORS.length} vendors with zone assignments`);

  for (const attendant of ATTENDANTS) {
    const userId = `usr_${attendant.id}`;
    await prisma.user.upsert({
      where: { id: userId },
      create: {
        id: userId,
        name: attendant.name,
        phone: attendant.phone,
        role: UserRole.ATTENDANT,
        status: UserStatus.ACTIVE,
        passwordHash,
      },
      update: { passwordHash },
    });

    await prisma.attendant.upsert({
      where: { id: attendant.id },
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
  console.log(`✔ ${ATTENDANTS.length} attendants`);

  const effectiveFrom = new Date("2026-04-01T00:00:00Z");
  for (const tariff of TARIFFS) {
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
  console.log(`✔ ${TARIFFS.length} published tariffs`);

  for (const vehicle of PLATES) {
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
  console.log(`✔ ${PLATES.length} vehicles`);

  // A handful of sessions so the operations screens are not empty: some still
  // running, one long enough to be an overstay, and some closed with a fare.
  const sessions = [
    { code: "KMCP-SEED01", plate: "WB02AB1234", zoneId: "zn_pks_01", attendantId: "att_001", vendorId: "ven_metro", startedMinutesAgo: 45, endedMinutesAgo: null },
    { code: "KMCP-SEED02", plate: "WB06C4455", zoneId: "zn_pks_02", attendantId: "att_002", vendorId: "ven_metro", startedMinutesAgo: 120, endedMinutesAgo: null },
    { code: "KMCP-SEED03", plate: "WB20K9911", zoneId: "zn_cam_01", attendantId: "att_003", vendorId: "ven_metro", startedMinutesAgo: 25, endedMinutesAgo: null },
    { code: "KMCP-SEED04", plate: "WB24T7788", zoneId: "zn_gar_01", attendantId: "att_004", vendorId: "ven_orbit", startedMinutesAgo: 430, endedMinutesAgo: null },
    { code: "KMCP-SEED05", plate: "WB19E3322", zoneId: "zn_hin_01", attendantId: "att_005", vendorId: "ven_orbit", startedMinutesAgo: 300, endedMinutesAgo: 60 },
    { code: "KMCP-SEED06", plate: "WB02AJ8080", zoneId: "zn_ras_01", attendantId: "att_006", vendorId: "ven_orbit", startedMinutesAgo: 260, endedMinutesAgo: 140 },
    { code: "KMCP-SEED07", plate: "WB74M2211", zoneId: "zn_pks_01", attendantId: "att_001", vendorId: "ven_metro", startedMinutesAgo: 600, endedMinutesAgo: 480 },
    { code: "KMCP-SEED08", plate: "WB12F6543", zoneId: "zn_gar_01", attendantId: "att_004", vendorId: "ven_orbit", startedMinutesAgo: 1500, endedMinutesAgo: 1380 },
  ];

  for (const s of sessions) {
    const vehicle = await prisma.vehicle.findUnique({ where: { plateNumber: s.plate } });
    if (!vehicle) continue;

    const startAt = minutesAgo(s.startedMinutesAgo);
    const endAt = s.endedMinutesAgo === null ? null : minutesAgo(s.endedMinutesAgo);
    const durationMinutes = endAt ? s.startedMinutesAgo - s.endedMinutesAgo! : null;

    // Rough figures only — a real fare comes from the quote service when the
    // session is actually ended through the API.
    const hours = durationMinutes ? Math.max(1, Math.ceil(durationMinutes / 60)) : 0;
    const gross = durationMinutes ? 2000 + Math.max(0, hours - 1) * 1500 : null;
    const tax = gross ? Math.round(gross * 0.18) : null;

    await prisma.parkingSession.upsert({
      where: { code: s.code },
      create: {
        code: s.code,
        zoneId: zoneId.get(s.zoneId)!,
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
        startLat: ZONES.find((z) => z.id === s.zoneId)?.lat,
        startLng: ZONES.find((z) => z.id === s.zoneId)?.lng,
        grossAmount: gross,
        taxAmount: tax ?? 0,
        payableAmount: gross && tax ? gross + tax : null,
      },
      update: {},
    });
  }
  console.log(`✔ ${sessions.length} parking sessions`);
}
