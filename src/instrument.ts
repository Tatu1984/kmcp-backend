/**
 * The first module `main.ts` loads.
 *
 * Sentry's Node SDK patches the modules it instruments as it initialises, so it
 * has to run before Nest, Express and Prisma are required — hence a file whose
 * only job is one side effect, imported at the top of the entry point rather
 * than called from inside `bootstrap()`. Importing it there would also mean a
 * failure *during* bootstrap went unreported, which is the failure most likely
 * to take the whole deployment down.
 *
 * Does nothing at all when `SENTRY_DSN` is unset.
 */
import { initSentry } from "./observability/sentry";

initSentry();
