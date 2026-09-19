import { Injectable, Logger } from "@nestjs/common";
import { PaymentStatus, Prisma, SessionStatus, Vehicle } from "@prisma/client";

import { PrismaService } from "@/prisma/prisma.service";
import { AppException } from "@/common/errors/app.exception";
import { AuditService } from "@/common/services/audit.service";
import { skipTake } from "@/common/dto/pagination.dto";
import { normalisePlate } from "@/common/utils/plate.util";
import { elapsedMinutesOf, isOverstaying } from "@/common/utils/session-clock.util";
import { storedQuote } from "@/modules/tariffs/quote.service";
import type { AuthenticatedUser } from "@/common/decorators/auth.decorators";
import type {
  AddFavouriteDto,
  AddVehicleDto,
  ClaimSessionDto,
  MyPaymentsQueryDto,
  MySessionsQueryDto,
} from "./dto/me.dto";

type Ctx = { ip?: string; requestId?: string };

const CAPTURED: PaymentStatus[] = [PaymentStatus.CAPTURED, PaymentStatus.PARTIALLY_REFUNDED];

/** A session is still parked if it is either of these. The sweep moves one to the other. */
const PARKED: SessionStatus[] = [SessionStatus.ACTIVE, SessionStatus.OVERSTAY];

/**
 * How long after a session ends its code can still be used to claim it.
 *
 * Short on purpose. The window exists for the driver who paid at the kerb and
 * opened the app afterwards, so their receipt is reachable; it does not exist
 * so that a code overheard or guessed weeks later can pull a stranger's parking
 * into an account. Three hours covers the walk back to the car and an evening's
 * delay, and nothing beyond that has a claim to make — a citizen who wants
 * their older history adds the plate to their garage instead, which is the same
 * ownership rule reached the honest way.
 */
const CLAIMABLE_AFTER_END_MINUTES = 180;

const MY_VEHICLE_SELECT = {
  id: true,
  plateNumber: true,
  makeModel: true,
  colour: true,
  isBlacklisted: true,
  vehicleType: { select: { code: true, label: true } },
} satisfies Prisma.VehicleSelect;

/**
 * One citizen's own session, with everything their screens draw and nothing
 * else.
 *
 * What was missing was most of it. The app is meant to show the bay an
 * attendant allocated, a ticking timer, and — once the car has left — the
 * calculation behind the total. It had the total and the zone: no `slot`, so
 * the citizen could not be told where their own car was parked; no
 * `fareBreakdown` and no amount components, so an unparked session showed a
 * figure with nothing behind it; and `durationMinutes` computed from the
 * timestamps rather than read from the column the fare was actually computed
 * on.
 *
 * Still deliberately not a staff payload: no vendor, no attendant, no shift, no
 * evidence media, no geo fixes. It is one citizen's own row.
 */
const MY_SESSION_SELECT = {
  id: true,
  code: true,
  plateNumber: true,
  status: true,
  startAt: true,
  endAt: true,
  durationMinutes: true,
  grossAmount: true,
  discountAmount: true,
  taxAmount: true,
  penaltyAmount: true,
  payableAmount: true,
  fareBreakdown: true,
  zone: { select: { id: true, code: true, name: true } },
  /** The allocated bay. Null where the zone has no mapped bays, which is most of them. */
  slot: { select: { id: true, code: true, type: true } },
  vehicleType: { select: { code: true, label: true } },
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

type MySessionRow = Prisma.ParkingSessionGetPayload<{ select: typeof MY_SESSION_SELECT }>;

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

  /**
   * The overstay grace period, read from the same `SystemConfig` row
   * `SessionsService` reads it from.
   *
   * Read here rather than passed in, so the citizen app and the operations
   * board can never disagree about whether a car is overstaying — the same
   * reason `ZonesService.geofenceTolerance` reads its own tolerance instead of
   * each caller carrying a copy. The fallback matches that service's, so a
   * deployment that has never set the key behaves identically on both sides.
   */
  private async overstayAfterMinutes(): Promise<number> {
    const row = await this.prisma.systemConfig.findUnique({
      where: { key: "ops.overstayAfterMinutes" },
    });
    const value = Number(row?.value ?? 360);
    return Number.isFinite(value) ? value : 360;
  }

  /**
   * One session in the shape every citizen screen reads.
   *
   * `now` is passed in rather than taken here so that a list of sessions is
   * timed from one instant: rows a few milliseconds apart must not straddle a
   * minute boundary and show two different elapsed times for the same refresh.
   */
  private mapSession(session: MySessionRow, overstayAfterMinutes: number, now: number) {
    const payment = session.payments[0] ?? null;
    return {
      id: session.id,
      code: session.code,
      plateNumber: session.plateNumber,
      status: session.status,
      startAt: session.startAt,
      endAt: session.endAt,
      /**
       * The minutes the fare was actually computed on. Null while the car is
       * still there, because nothing has been charged yet — and left null
       * rather than filled in from the timestamps, so that a figure shown
       * beside a total is always the figure that total was worked out from.
       * `elapsedMinutes` beneath it is the one a live screen reads, and is
       * never null: it is where the app's ticking clock starts.
       */
      durationMinutes: session.durationMinutes,
      elapsedMinutes: elapsedMinutesOf(session, now),
      isOverstay: isOverstaying(session, overstayAfterMinutes, now),
      grossAmount: session.grossAmount,
      discountAmount: session.discountAmount,
      taxAmount: session.taxAmount,
      penaltyAmount: session.penaltyAmount,
      payableAmount: session.payableAmount,
      /** The stored quote, line by line: what the citizen is shown when they ask why. */
      fareBreakdown: storedQuote(session.fareBreakdown),
      refundedAmount: payment?.refundedAmount ?? 0,
      zone: session.zone,
      slot: session.slot,
      vehicleType: session.vehicleType,
      payment: payment ? { id: payment.id, mode: payment.mode, status: payment.status } : null,
      receipt: payment?.receipt ?? null,
    };
  }

  async listSessions(query: MySessionsQueryDto, user: AuthenticatedUser) {
    const [overstayAfterMinutes, sessions] = await Promise.all([
      this.overstayAfterMinutes(),
      this.prisma.parkingSession.findMany({
        where: {
          vehicle: { ownerUserId: user.id },
          ...(query.status ? { status: query.status } : {}),
        },
        select: MY_SESSION_SELECT,
        orderBy: { startAt: "desc" },
        ...skipTake(query),
      }),
    ]);

    const now = Date.now();
    return sessions.map((session) => this.mapSession(session, overstayAfterMinutes, now));
  }

  /**
   * What this citizen is parked in right now.
   *
   * `?status=` on the list above takes a single value, and the overstay sweep
   * promotes a session from ACTIVE to OVERSTAY with no warning — so an app
   * polling `?status=ACTIVE` watched its own live session disappear from the
   * screen six hours in, at the moment the driver most needed to see it. Both
   * statuses mean one thing to the person who parked: the car is still there.
   *
   * Returns a list, not one session. `startOnce` enforces one live session per
   * plate, but a citizen may own several vehicles and have two of them parked
   * at once; answering with a single row would have hidden one of their cars.
   * Newest first, so the one they just parked is the one they see.
   */
  async listActiveSessions(user: AuthenticatedUser) {
    const [overstayAfterMinutes, sessions] = await Promise.all([
      this.overstayAfterMinutes(),
      this.prisma.parkingSession.findMany({
        where: { vehicle: { ownerUserId: user.id }, status: { in: PARKED } },
        select: MY_SESSION_SELECT,
        orderBy: { startAt: "desc" },
      }),
    ]);

    const now = Date.now();
    return sessions.map((session) => this.mapSession(session, overstayAfterMinutes, now));
  }

  /**
   * Attaches a session to this account from the code on the ticket.
   *
   * A citizen's history is found through `vehicle.ownerUserId`, so a driver who
   * never registered their plate has no way to reach the session an attendant
   * just started for them: the bay, the timer and the fare exist and belong to
   * nobody. Quoting the code is the way in — it is printed on the ticket and
   * readable by whoever is standing at the car.
   *
   * Which is also why it cannot open just any session. The code is six
   * characters from a 32-letter alphabet, which is guessable given enough
   * attempts, so a claim is accepted only for a session that is still live or
   * one that completed within `CLAIMABLE_AFTER_END_MINUTES`. Nothing else in
   * this codebase had reasoned about the question before — the code is used for
   * staff lookups, which are scoped by zone or vendor instead — so the rule is
   * made here and is the narrow one.
   *
   * The ownership check underneath does the rest of the work. A code proves the
   * holder was at the car; it does not outrank a plate somebody has already
   * claimed, and `resolveOrClaimVehicle` refuses that case without saying whose
   * account it belongs to.
   */
  async claimSession(dto: ClaimSessionDto, user: AuthenticatedUser, ctx: Ctx) {
    const code = dto.code.trim().toUpperCase();

    const session = await this.prisma.parkingSession.findUnique({
      where: { code },
      select: MY_SESSION_SELECT,
    });
    if (!session) throw AppException.notFound("session");

    const endedRecently =
      session.endAt !== null &&
      session.endAt.getTime() > Date.now() - CLAIMABLE_AFTER_END_MINUTES * 60_000;
    const claimable =
      PARKED.includes(session.status) ||
      (session.status === SessionStatus.COMPLETED && endedRecently);

    if (!claimable) {
      // SESSION_NOT_ACTIVE, because the refusal is about the state of the
      // session and not about the request, which was perfectly well formed. A
      // cancelled session lands here too and should: there is no bay, no timer
      // and no fare on it to claim.
      throw new AppException(
        "SESSION_NOT_ACTIVE",
        [{ field: "code", issue: `session is ${session.status}` }],
        "That parking session can no longer be claimed. Add the vehicle to your account instead — its history follows the plate.",
      );
    }

    // The claim is on the vehicle, not the session. Ownership of the plate is
    // what makes every session on it visible to this account — this one, the
    // ones before it and the ones after — and `resolveOrClaimVehicle` is the
    // single rule for that. It already answers every case correctly: unowned is
    // claimed and audited, already this citizen's is returned untouched, and
    // another account's is refused. Calling it rather than writing those
    // branches again is what stops the two entry points drifting into subtly
    // different ideas about who owns a plate.
    await this.resolveOrClaimVehicle(session.plateNumber, session.vehicleType.code, user, ctx);

    await this.audit.record({
      actor: user,
      action: "SESSION_CLAIM",
      entity: "ParkingSession",
      entityId: session.id,
      after: { code: session.code, plateNumber: session.plateNumber, status: session.status },
      ...ctx,
    });

    // The same shape `/me/sessions` returns, so the app renders the claimed
    // session from this response without a second round trip.
    return this.mapSession(session, await this.overstayAfterMinutes(), Date.now());
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
