/**
 * How long a parking session has been running, and whether it has run too long.
 *
 * Both answers were computed inline three times in `SessionsService`, and the
 * overstay test was already spelled two different ways: the list compared
 * `startAt` against a cutoff instant, the detail read compared rounded minutes
 * against the threshold. They agree except inside a sub-minute band around the
 * threshold — which is precisely where a citizen reading "not overstaying" in
 * the app and an officer reading "overstaying" on the operations board would
 * disagree about a penalty. A fourth copy was about to be written in
 * `MeService` for the citizen screens, so there is one definition here and
 * every surface reads it.
 */

/** What any of this needs. Every session select in the platform already carries these three. */
export interface SessionClock {
  startAt: Date;
  endAt: Date | null;
  /** The minutes the fare was computed on. Null while live, and on rows never priced. */
  durationMinutes: number | null;
}

/**
 * Minutes on the clock: still counting while the vehicle is parked, the settled
 * figure once it has left.
 *
 * A finished session reports `durationMinutes` rather than the difference
 * between its timestamps, because that is the duration its fare was actually
 * computed on — the tariff engine rounds a part minute up, so recomputing it
 * here would hand back a number that disagrees with the amount charged and
 * leave a disputed fare impossible to reconcile. The wall-clock fallback is for
 * rows that were never priced at all: a cancelled session, and every completed
 * session in the seeded history, which carry an `endAt` and no duration.
 */
export function elapsedMinutesOf(session: SessionClock, now: number = Date.now()): number {
  if (session.endAt === null) {
    return Math.round((now - session.startAt.getTime()) / 60_000);
  }
  return (
    session.durationMinutes ??
    Math.round((session.endAt.getTime() - session.startAt.getTime()) / 60_000)
  );
}

/**
 * Whether a session still running has passed the overstay threshold.
 *
 * Only a live session can be overstaying. Once it has ended the question is
 * settled and the answer is money, not a boolean: `Quote.penaltyAmount` is the
 * record of it.
 *
 * Measured against the exact instant rather than the rounded minute count so
 * that it agrees with `markOverstays`, which promotes rows on
 * `startAt < cutoff`. A session the sweep has already moved to OVERSTAY must
 * never read back as being within its time.
 */
export function isOverstaying(
  session: SessionClock,
  overstayAfterMinutes: number,
  now: number = Date.now(),
): boolean {
  if (session.endAt !== null) return false;
  return session.startAt.getTime() < now - overstayAfterMinutes * 60_000;
}
