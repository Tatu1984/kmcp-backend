import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PrismaClient, SlotType, UserRole, UserStatus } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import * as bcrypt from "bcryptjs";
import { seedOperations } from "./seed-operations";

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? "" }),
});

/**
 * Everything this loads lives in `prisma/data/*.json`, not in this file.
 *
 * Reference data, configuration and staff are all things the authority will
 * eventually supply from its own records. Keeping them as data means replacing
 * them is a file swap that anyone can review in a diff, rather than an edit to
 * TypeScript that only a developer can make.
 */
const DATA_DIR = join(__dirname, "data");

function load<T>(file: string): T[] {
  try {
    return JSON.parse(readFileSync(join(DATA_DIR, file), "utf8")) as T[];
  } catch (error) {
    throw new Error(`Could not read seed data from prisma/data/${file} — ${String(error)}`);
  }
}

interface VehicleTypeRow {
  code: SlotType;
  label: string;
  sortOrder: number;
  isActive?: boolean;
}
interface ConfigRow {
  key: string;
  value: unknown;
}
interface StaffRow {
  email: string;
  name: string;
  phone?: string;
  role: UserRole;
}

async function main() {
  const password = process.env.SEED_PASSWORD ?? "kmcp-demo-2026";
  const passwordHash = await bcrypt.hash(password, 12);

  /**
   * Vehicle types are keyed by their own code.
   *
   * Deliberate: `vehicleTypeId` is a foreign key, and the mobile apps send
   * `"CAR"` rather than an opaque cuid. That keeps the wire contract readable
   * while still giving the authority a table it can extend.
   */
  const vehicleTypes = load<VehicleTypeRow>("vehicle-types.json");
  for (const type of vehicleTypes) {
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
  console.log(`✔ ${vehicleTypes.length} vehicle types`);

  // Never overwritten on re-run: an operator may have tuned the grace period or
  // the geo-fence tolerance in the portal, and a seed must not undo that.
  const config = load<ConfigRow>("system-config.json");
  for (const entry of config) {
    await prisma.systemConfig.upsert({
      where: { key: entry.key },
      create: { key: entry.key, value: entry.value as never },
      update: {},
    });
  }
  console.log(`✔ ${config.length} configuration keys`);

  const staff = load<StaffRow>("staff.json");
  for (const person of staff) {
    await prisma.user.upsert({
      where: { email: person.email },
      create: {
        email: person.email,
        name: person.name,
        phone: person.phone,
        role: person.role,
        status: UserStatus.ACTIVE,
        passwordHash,
      },
      update: { passwordHash, role: person.role },
    });
  }
  console.log(`✔ ${staff.length} staff accounts (password: ${password})`);

  // Geography, kerb, operators, staff, tariffs and sessions — everything the
  // portal needs in order to show something other than an empty state.
  await seedOperations(prisma);

  console.log("\nSeed complete.");
}

main()
  .catch((error) => {
    console.error("Seed failed:", error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
