# KMCP API

The backend for the **Smart Street Parking Management System** — a standalone NestJS service that
owns the database and serves every client:

| Client | Repo |
|---|---|
| Admin Portal | `Tatu1984/kmcp` |
| Vendor app (attendants) | React Native / Expo — planned |
| Citizen app (vehicle owners) | React Native / Expo — planned |

Deployed and versioned independently of the portal, because the mobile apps talk to it directly.

**Phase 1**: the attendant photographs the number plate and types the registration number. ANPR
auto-recognition is Phase 2 and attaches at the capture step without changing anything downstream.

---

## Getting started

```bash
cp .env.example .env      # fill in DATABASE_URL and the two JWT secrets
npm install
npm run db:deploy         # apply migrations
npm run dev               # http://localhost:4000/api/v1
```

OpenAPI docs are served at `/api/v1/docs` (and `/api/v1/docs.json` for client generation).

> **Prisma 7 note:** a `prisma.config.ts` file disables Prisma's automatic `.env` loading. Load it
> yourself before any CLI command:
> ```bash
> set -a && . ./.env && set +a && npm run db:migrate
> ```

---

## Architecture

```
src/
├── common/          cross-cutting: guards, filters, interceptors, decorators, RBAC, utils
├── config/          env validation (Zod) and app constants
├── prisma/          PrismaService — the only place the client is constructed
├── modules/         one folder per domain: controller → service → Prisma
└── main.ts          bootstrap; also exported for the serverless entry
```

### Rules the code holds to

| # | Rule | Why |
|---|---|---|
| 1 | **Money is integer paise** | Floats and currency do not mix. `money.util.ts` is the only place arithmetic happens. |
| 2 | **Fares are computed only in `QuoteService`** | One authority means the portal, vendor app and citizen app can never disagree about a price. |
| 3 | **No business rules on any device** | A tariff change takes effect on the next request, with no app release. |
| 4 | **Every mutation is audited** | Actor, before/after, IP, device and request id. Append-only. |
| 5 | **Idempotency on anything that creates money or a session** | Retrying at the kerb is safe; a flaky network never double-charges. |
| 6 | **Zone scope is applied in the query** | A scoped caller cannot page past their own kerb. |
| 7 | **Times are UTC** | Rendered in `Asia/Kolkata` at the edge. |

### The response envelope

```jsonc
// success
{ "success": true, "data": { }, "meta": { "requestId": "…", "page": 1, "total": 42 } }

// failure — branch on `error.code`, never on `error.message`
{ "success": false, "error": { "code": "SESSION_ALREADY_ACTIVE", "message": "…", "details": [] },
  "meta": { "requestId": "…" } }
```

The full error vocabulary lives in `src/common/errors/error-codes.ts`.

---

## Authentication

| Actor | Flow |
|---|---|
| Municipal staff, vendors | `POST /auth/login` → `two_factor_required` → `POST /auth/two-factor/verify` |
| Citizens | `POST /auth/otp/request` → `POST /auth/otp/verify` (creates the account on first use) |
| Attendants | Login, then `POST /auth/device/bind` — their token only works from that handset |

Access tokens are short-lived; refresh tokens are single-use and grouped into a family. **Presenting
a refresh token twice revokes the whole family** and returns `TOKEN_REUSED`, which turns a stolen
token into one wasted request rather than persistent access.

---

## Testing

```bash
npm test          # vitest
npm run typecheck
```

`test/quote.service.spec.ts` is the golden matrix for the fare engine — one case per pricing
dimension in the scope of work (grace period, blocks, peak, weekend, night wrap-around, holiday,
compounding, daily cap, overstay, discounts, passes, zone-specific override, integer-paise
invariant). Any change to pricing must keep it green.

---

## Deploying to Vercel

The repo carries `vercel.json` and `api/index.ts`, which wraps the Nest app in a serverless handler
and caches it across warm invocations. Import the repo as its own Vercel project and set the
environment variables from `.env.example`.

**Migrations are not part of the build** — they would fire on every preview deploy and can race
between concurrent builds. Apply them explicitly:

```bash
set -a && . ./.env && set +a && npm run db:deploy
```

Set `CORS_ORIGINS` to the portal's domain (comma-separated for more than one).

---

## Status

| Area | State |
|---|---|
| Foundation — config, Prisma, envelope, filters, guards, audit, idempotency | Done |
| Auth — login, 2FA, citizen OTP, refresh rotation, device binding, RBAC | Done |
| Zones — CRUD, geo-fence resolution, nearby search, closure workflow | Done |
| Tariffs — versioning, publish workflow, rules, holidays, discounts, quote engine | Done |
| Slots, vendors, attendants, shifts | Next |
| Sessions, media, payments, receipts | Next |
| Settlements, reports, governance | Next |
| Seed dataset | Next |
