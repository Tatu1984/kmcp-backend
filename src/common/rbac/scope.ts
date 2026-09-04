import type { AuthenticatedUser } from "../decorators/auth.decorators";

/**
 * The zones this principal may see, or `null` when they are unrestricted.
 *
 * The distinction is the whole point, and `zoneIds` on its own cannot carry it.
 * An empty array means "no restriction" for an administrator and "nothing
 * allocated yet" for a zone officer, and every service that branched on
 * `zoneIds.length === 0` answered the second case as though it were the first.
 *
 * That was not a rare edge. `JwtAuthGuard.resolveZoneScope` returns `[]`
 * whenever the `zoneScope:<userId>` row is absent, and `UsersService` writes
 * that row only when the create call supplied a non-empty list — so a zone
 * officer created without an allocation was given the whole city, silently, by
 * default. `isZoneScoped` is resolved from the role at authentication and is
 * what actually separates the two.
 *
 * An empty allocation therefore comes back as an empty list, and `{ in: [] }`
 * matches no rows. Someone assigned no zones sees nothing, which is the only
 * safe reading of "we have not decided what they may see yet".
 */
export function zoneScopeOf(user: AuthenticatedUser): string[] | null {
  return user.isZoneScoped ? user.zoneIds : null;
}

/**
 * Combines an access scope with filters the caller supplied, so that a caller
 * can only ever narrow their view and never widen it.
 *
 * Spreading both into one object literal is the obvious thing to write and is
 * silently wrong:
 *
 *     { ...this.scopeFilter(user), ...(query.zoneId ? { zoneId: query.zoneId } : {}) }
 *
 * Both branches write `zoneId`, and in an object literal the last one wins — so
 * `?zoneId=<somebody else's zone>` did not narrow the scope, it replaced it.
 * Nothing threw; the rows simply arrived. Passing the two as separate arguments
 * makes that impossible to express: they are ANDed, never merged, so a
 * caller-supplied key intersects the scope instead of overwriting it, whatever
 * key it happens to use.
 *
 * A single non-empty clause is returned unwrapped, so an unscoped caller's
 * query is exactly the query it was before this existed.
 */
export function scoped<W extends object>(scope: W, ...filters: (W | undefined | null)[]): W {
  const clauses = [scope, ...filters].filter(
    (clause): clause is W => clause != null && Object.keys(clause).length > 0,
  );

  if (clauses.length === 0) return {} as W;
  if (clauses.length === 1) return clauses[0];
  return { AND: clauses } as W;
}
