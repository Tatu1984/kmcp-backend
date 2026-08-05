import { PrismaClient, SlotType, UserRole, UserStatus } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import * as bcrypt from "bcryptjs";

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? "" }),
});

/**
 * Vehicle types are reference data keyed by their own code.
 *
 * Using the code as the primary key is deliberate: `vehicleTypeId` is a foreign
 * key, and the mobile apps send `"CAR"` rather than an opaque cuid. That keeps
 * the wire contract readable while still giving the authority a table it can
 * extend with new categories.
 */
const VEHICLE_TYPES: { code: SlotType; label: string; sortOrder: number; isActive?: boolean }[] = [
  { code: SlotType.TWO_WHEELER, label: "Two Wheeler", sortOrder: 1 },
  { code: SlotType.THREE_WHEELER, label: "Three Wheeler", sortOrder: 2 },
  { code: SlotType.CAR, label: "Car", sortOrder: 3 },
  { code: SlotType.EV, label: "Electric Vehicle", sortOrder: 4 },
  { code: SlotType.COMMERCIAL, label: "Commercial", sortOrder: 5 },
  { code: SlotType.BUS, label: "Bus", sortOrder: 6 },
  { code: SlotType.TRUCK, label: "Truck", sortOrder: 7 },
  { code: SlotType.VIP, label: "VIP", sortOrder: 8 },
  { code: SlotType.GOVERNMENT, label: "Government", sortOrder: 9 },
  { code: SlotType.ACCESSIBLE, label: "Accessible", sortOrder: 10, isActive: false },
];

const STAFF = [
  {
    email: "sudipta.banerjee@kmc.gov.in",
    name: "Sudipta Banerjee",
    phone: "+919830011223",
    role: UserRole.SUPER_ADMIN,
  },
  { email: "rina.dasgupta@kmc.gov.in", name: "Rina Dasgupta", role: UserRole.ADMIN },
  { email: "prabir.c@kmc.gov.in", name: "Prabir Chatterjee", role: UserRole.ZONE_OFFICER },
  { email: "audit@kmc.gov.in", name: "Audit Cell", role: UserRole.AUDITOR },
];

const SYSTEM_CONFIG: { key: string; value: unknown }[] = [
  { key: "ops.geofenceToleranceM", value: 25 },
  { key: "ops.defaultGracePeriodMin", value: 10 },
  { key: "ops.overstayAfterMinutes", value: 360 },
  { key: "ops.maxSyncBatch", value: 50 },
  { key: "tax.gstPercent", value: 18 },
  { key: "tax.invoicePrefix", value: "RCPT/" },
  { key: "settlement.defaultCycle", value: "WEEKLY" },
  { key: "settlement.defaultCommissionPct", value: 18 },
  { key: "settlement.holdOnVariance", value: true },
  { key: "settlement.blockPayoutUntilKyc", value: true },
];

async function main() {
  const password = process.env.SEED_PASSWORD ?? "kmcp-demo-2026";
  const passwordHash = await bcrypt.hash(password, 12);

  // ---- reference data -----------------------------------------------------
  for (const type of VEHICLE_TYPES) {
    await prisma.vehicleType.upsert({
      where: { id: type.code },
      create: {
        id: type.code,
        code: type.code,
        label: type.label,
        sortOrder: type.sortOrder,
        isActive: type.isActive ?? true,
      },
      update: { label: type.label, sortOrder: type.sortOrder },
    });
  }
  console.log(`✔ ${VEHICLE_TYPES.length} vehicle types`);

  // ---- system configuration ----------------------------------------------
  for (const entry of SYSTEM_CONFIG) {
    await prisma.systemConfig.upsert({
      where: { key: entry.key },
      create: { key: entry.key, value: entry.value as never },
      update: {},
    });
  }
  console.log(`✔ ${SYSTEM_CONFIG.length} configuration keys`);

  // ---- staff accounts ------------------------------------------------------
  for (const person of STAFF) {
    await prisma.user.upsert({
      where: { email: person.email },
      create: {
        email: person.email,
        name: person.name,
        phone: "phone" in person ? person.phone : undefined,
        role: person.role,
        status: UserStatus.ACTIVE,
        passwordHash,
      },
      update: { passwordHash, role: person.role },
    });
  }
  console.log(`✔ ${STAFF.length} staff accounts (password: ${password})`);

  console.log("\nSeed complete.");
}

main()
  .catch((error) => {
    console.error("Seed failed:", error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
