import { Injectable, Logger } from "@nestjs/common";
import { PaymentStatus, Prisma, Vehicle } from "@prisma/client";

import { PrismaService } from "@/prisma/prisma.service";
import { AppException } from "@/common/errors/app.exception";
import { AuditService } from "@/common/services/audit.service";
import { skipTake } from "@/common/dto/pagination.dto";
import { normalisePlate } from "@/common/utils/plate.util";
import type { AuthenticatedUser } from "@/common/decorators/auth.decorators";
import type {
  AddFavouriteDto,
  AddVehicleDto,
  MyPaymentsQueryDto,
  MySessionsQueryDto,
} from "./dto/me.dto";

type Ctx = { ip?: string; requestId?: string };

const CAPTURED: PaymentStatus[] = [PaymentStatus.CAPTURED, PaymentStatus.PARTIALLY_REFUNDED];

const MY_VEHICLE_SELECT = {
  id: true,
  plateNumber: true,
  makeModel: true,
  colour: true,
  isBlacklisted: true,
  vehicleType: { select: { code: true, label: true } },
} satisfies Prisma.VehicleSelect;

const MY_SESSION_SELECT = {
  id: true,
  code: true,
  plateNumber: true,
  status: true,
  startAt: true,
  endAt: true,
  payableAmount: true,
  zone: { select: { id: true, code: true, name: true } },
  // Only the payment that actually settled it — a session can carry a failed
  // attempt before the one that captured, and the citizen has no use for that.
  payments: {
    where: { status: { in: CAPTURED } },
    select: {
      id: true,
      mode: true,
      status: true,
      refundedAmount: true,
      receipt: { select: { id: true, number: true, issuedAt: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 1,
  },
} satisfies Prisma.ParkingSessionSelect;

/**
 * Kept minimal and duplicated from `PaymentsService`'s `PAYMENT_SELECT` rather
 * than importing it, since that file is being edited elsewhere at the same
 * time — a shared constant here would just be a merge conflict waiting to
 * happen. Field-for-field it is a subset of the same shape.
 */
const MY_PAYMENT_SELECT = {
  id: true,
  sessionId: true,
  mode: true,
  amount: true,
  status: true,
  paidAt: true,
  refundedAmount: true,
  receipt: { select: { id: true, number: true, issuedAt: true } },
} satisfies Prisma.PaymentSelect;

/**
 * A citizen's own things — vehicles, sessions, spend and favourites.
 *
 * Every read and write here is scoped to `user.id` and nothing here takes a
 * user id as an argument: the caller is always the citizen themselves, the
 * same guarantee `PaymentsService.collect` already leans on for
 * `/payments/collect`. As in `CitizensService`, a citizen's parking history is
 * reached through `vehicle.ownerUserId` rather than a column on the session —
 * see that file's doc comment for why.
 */
@Injectable()
export class MeService {
  private readonly logger = new Logger(MeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Finds, creates or claims the vehicle behind a plate on this citizen's
   * behalf.
   *
   * Shared with pass purchase, which needs the same "the citizen just typed a
   * plate — make it theirs" step. Three cases:
   *  - No vehicle exists for the plate yet: create one owned by this citizen.
   *  - One exists but nobody owns it (an attendant started a session for it
   *    before the owner ever opened the app): claim it, so the history
   *    already on the plate becomes this citizen's history.
   *  - One exists owned by someone else: refused — a plate cannot belong to
   *    two accounts.
   *  - One exists already owned by this citizen: returned as-is.
   */
  async resolveOrClaimVehicle(
    plateNumber: string,
    vehicleTypeCode: string,
    user: AuthenticatedUser,
    ctx: Ctx,
  ): Promise<Vehicle> {
    const plate = normalisePlate(plateNumber);

    const vehicleType = await this.prisma.vehicleType.findUnique({
      where: { code: vehicleTypeCode },
      select: { id: true },
    });
    if (!vehicleType) throw AppException.notFound("vehicle type");

    const existing = await this.prisma.vehicle.findUnique({ where: { plateNumber: plate } });

    if (!existing) {
      const created = await this.prisma.vehicle.create({
        data: { plateNumber: plate, vehicleTypeId: vehicleType.id, ownerUserId: user.id },
      });

      await this.audit.record({
        actor: user,
        action: "VEHICLE_CREATE",
        entity: "Vehicle",
        entityId: created.id,
        after: { plateNumber: plate, vehicleType: vehicleTypeCode },
        ...ctx,
      });

      return created;
    }

    if (existing.ownerUserId === user.id) return existing;

    if (existing.ownerUserId === null) {
      const claimed = await this.prisma.vehicle.update({
        where: { id: existing.id },
        data: { ownerUserId: user.id },
      });

      await this.audit.record({
        actor: user,
        action: "VEHICLE_CLAIM",
        entity: "Vehicle",
        entityId: existing.id,
        before: { ownerUserId: null },
        after: { ownerUserId: user.id },
        ...ctx,
      });

      return claimed;
    }

    throw new AppException(
      "DUPLICATE_RESOURCE",
      [{ field: "plateNumber", issue: "already registered to another account" }],
      "That plate is already registered to another account.",
    );
  }

  async listVehicles(user: AuthenticatedUser) {
    return this.prisma.vehicle.findMany({
      where: { ownerUserId: user.id },
      select: MY_VEHICLE_SELECT,
      orderBy: { createdAt: "desc" },
    });
  }

  async addVehicle(dto: AddVehicleDto, user: AuthenticatedUser, ctx: Ctx) {
    const vehicle = await this.resolveOrClaimVehicle(dto.plateNumber, dto.vehicleType, user, ctx);
    return this.prisma.vehicle.findUniqueOrThrow({
      where: { id: vehicle.id },
      select: MY_VEHICLE_SELECT,
    });
  }

  /**
   * Removes a vehicle from this citizen's garage.
   *
   * Not a hard delete. `Vehicle` has no `deletedAt` column, and its `id` is a
   * required foreign key on `ParkingSession`, `Pass` and (through the
   * session) on every `Payment` and `Receipt` ever issued against it — a hard
   * delete on a plate with any history would fail on the database's own
   * foreign-key constraint, or worse, succeed on a plate with none and
   * silently pass on the next one that has some. `ownerUserId` is already
   * nullable for exactly this reason: it is how a session started before the
   * citizen ever opened the app is told apart from one they claimed, so
   * setting it back to null — releasing the vehicle rather than destroying
   * it — reuses that same column instead of inventing a new one. The plate,
   * its sessions and its payment history all stay exactly as they were; only
   * this citizen's claim over the plate is withdrawn, and re-adding the same
   * plate re-claims it.
   */
  async removeVehicle(vehicleId: string, user: AuthenticatedUser, ctx: Ctx): Promise<void> {
    const vehicle = await this.prisma.vehicle.findFirst({
      where: { id: vehicleId, ownerUserId: user.id },
      select: { id: true, plateNumber: true },
    });
    if (!vehicle) throw AppException.notFound("vehicle");

    await this.prisma.vehicle.update({
      where: { id: vehicle.id },
      data: { ownerUserId: null },
    });

    await this.audit.record({
      actor: user,
      action: "VEHICLE_RELEASE",
      entity: "Vehicle",
      entityId: vehicle.id,
      before: { ownerUserId: user.id },
      after: { ownerUserId: null, plateNumber: vehicle.plateNumber },
      ...ctx,
    });
  }

  async listSessions(query: MySessionsQueryDto, user: AuthenticatedUser) {
    const sessions = await this.prisma.parkingSession.findMany({
      where: {
        vehicle: { ownerUserId: user.id },
        ...(query.status ? { status: query.status } : {}),
      },
      select: MY_SESSION_SELECT,
      orderBy: { startAt: "desc" },
      ...skipTake(query),
    });

    return sessions.map((session) => {
      const payment = session.payments[0] ?? null;
      return {
        id: session.id,
        code: session.code,
        plateNumber: session.plateNumber,
        status: session.status,
        startAt: session.startAt,
        endAt: session.endAt,
        durationMinutes: session.endAt
          ? Math.round((session.endAt.getTime() - session.startAt.getTime()) / 60_000)
          : null,
        payableAmount: session.payableAmount,
        refundedAmount: payment?.refundedAmount ?? 0,
        zone: session.zone,
        payment: payment ? { id: payment.id, mode: payment.mode, status: payment.status } : null,
        receipt: payment?.receipt ?? null,
      };
    });
  }

  /** "2026-09" for the current instant, in UTC — matching every other timestamp in this platform. */
  private currentMonth(): string {
    const now = new Date();
    return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  }

  private monthRange(month: string): { start: Date; end: Date } {
    const [year, monthIndex] = month.split("-").map(Number);
    const start = new Date(Date.UTC(year, monthIndex - 1, 1));
    const end = new Date(Date.UTC(year, monthIndex, 1));
    return { start, end };
  }

  /** The two figures at the top of the History screen, for one calendar month. */
  async summary(month: string | undefined, user: AuthenticatedUser) {
    const targetMonth = month ?? this.currentMonth();
    const { start, end } = this.monthRange(targetMonth);

    const payments = await this.prisma.payment.findMany({
      where: {
        status: { in: CAPTURED },
        OR: [{ session: { vehicle: { ownerUserId: user.id } } }, { paidByUserId: user.id }],
        paidAt: { gte: start, lt: end },
      },
      select: { amount: true, refundedAmount: true, sessionId: true },
    });

    const totalPaid = payments.reduce((sum, p) => sum + p.amount, 0);
    const totalRefunded = payments.reduce((sum, p) => sum + p.refundedAmount, 0);
    const sessions = new Set(
      payments.map((p) => p.sessionId).filter((id): id is string => id !== null),
    ).size;

    return { month: targetMonth, totalPaid, totalRefunded, sessions };
  }

  async listPayments(query: MyPaymentsQueryDto, user: AuthenticatedUser) {
    return this.prisma.payment.findMany({
      where: {
        status: { in: CAPTURED },
        OR: [{ session: { vehicle: { ownerUserId: user.id } } }, { paidByUserId: user.id }],
      },
      select: MY_PAYMENT_SELECT,
      orderBy: { createdAt: "desc" },
      ...skipTake(query),
    });
  }

  async listFavourites(user: AuthenticatedUser) {
    return this.prisma.favourite.findMany({
      where: { userId: user.id },
      select: {
        id: true,
        zoneId: true,
        label: true,
        zone: { select: { id: true, code: true, name: true } },
      },
    });
  }

  /**
   * Idempotent on the `[userId, zoneId]` unique constraint: saving a zone
   * that is already saved just answers with what is already there rather
   * than refusing the second tap.
   */
  async addFavourite(dto: AddFavouriteDto, user: AuthenticatedUser, ctx: Ctx) {
    const zone = await this.prisma.zone.findUnique({
      where: { id: dto.zoneId },
      select: { id: true, code: true, name: true },
    });
    if (!zone) throw AppException.notFound("zone");

    const favourite = await this.prisma.favourite.upsert({
      where: { userId_zoneId: { userId: user.id, zoneId: dto.zoneId } },
      create: { userId: user.id, zoneId: dto.zoneId, label: dto.label },
      update: {},
      select: { id: true, zoneId: true, label: true },
    });

    await this.audit.record({
      actor: user,
      action: "FAVOURITE_ADD",
      entity: "Favourite",
      entityId: favourite.id,
      after: { zoneId: dto.zoneId, label: dto.label },
      ...ctx,
    });

    return { ...favourite, zone };
  }

  async removeFavourite(zoneId: string, user: AuthenticatedUser, ctx: Ctx): Promise<void> {
    const favourite = await this.prisma.favourite.findUnique({
      where: { userId_zoneId: { userId: user.id, zoneId } },
      select: { id: true },
    });
    if (!favourite) throw AppException.notFound("favourite");

    await this.prisma.favourite.delete({ where: { id: favourite.id } });

    await this.audit.record({
      actor: user,
      action: "FAVOURITE_REMOVE",
      entity: "Favourite",
      entityId: favourite.id,
      before: { zoneId },
      ...ctx,
    });
  }
}
