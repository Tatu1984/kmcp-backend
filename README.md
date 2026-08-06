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
npm run db:seed           # reference data + staff accounts
npm run dev               # http://localhost:4000/api/v1
```

The seed creates the vehicle types, system configuration and four staff accounts
(`kmcp-demo-2026`, override with `SEED_PASSWORD`). **It is required** — `Tariff.vehicleTypeId`
and `ParkingSession.vehicleTypeId` are foreign keys to `VehicleType`, whose primary key is its
own code, so `"CAR"` on the wire resolves to a real row. Without the seed every tariff write
fails its foreign key.

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

## Activity monitor

Every sign-in attempt is recorded with the network, place and device it came from — including
attempts against accounts that do not exist, so credential stuffing is visible.

| Captured | |
|---|---|
| Who | account, name, role, or the identifier tried on a failure |
| Where | IP, city, locality, region, PIN, country, coordinates, ISP, ASN, VPN/proxy flag |
| What | browser, OS, device type, fingerprint, device timezone |
| Verdict | anomalies found and a 0–100 risk score |

Geolocation comes from Vercel's edge headers first (free, no call), then ipinfo when
`IPINFO_TOKEN` is set, then ip-api as a baseline, refined to a named locality. Every lookup has a
tight timeout and degrades to unknown — **a slow geo API must never hold up a sign-in.**

### What gets flagged

| Signal | Severity |
|---|---|
| `CONCURRENT_SESSION_DIFFERENT_LOCATION` — another live session elsewhere | high |
| `IMPOSSIBLE_TRAVEL` — faster than a jet between two sign-ins | high |
| `SUCCESS_AFTER_REPEATED_FAILURES` — five or more failures in the previous 15 minutes | high |
| `VPN_OR_PROXY` | medium |
| `TIMEZONE_MISMATCH` — device timezone disagrees with the network's | medium |
| `NEW_COUNTRY`, `UNUSUAL_LOCALITY` | medium |
| `NEW_DEVICE` | medium for field accounts, low for office ones |

Concurrent sessions matter most here. An attendant account is meant to be one person, on one
handset, at one kerb — two live sessions in different cities is the shape account-sharing takes,
and it is exactly what lets collected cash go unrecorded.

False positives are handled by approving the sign-in, which allowlists that account and IP so the
same place stops flagging.

```
GET    /activity/overview                counts, live sessions, top cities, riskiest events
GET    /activity/events                  full feed, filterable by user, IP, city, risk, date
GET    /activity/users/:userId           one account: events, sessions, devices, usual places
GET    /activity/sessions                live sessions, each with its concurrency count
DELETE /activity/sessions/:sessionId     force a session to end
POST   /activity/events/:id/approve      trust this account and IP
GET    /activity/trusted                 the allowlist
DELETE /activity/trusted/:id             withdraw trust
GET    /auth/location-consent            your own precise-location consent
POST   /auth/location-consent            grant or withdraw it
```

Precise browser GPS is only ever stored with explicit consent, and withdrawing it **erases the
stored fix** rather than merely stopping new ones — which is what the DPDP Act requires of a
revocable consent.

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

Import the repo as its own Vercel project. `vercel.json` sets `framework: null`, so no preset is
applied. Set the environment variables from `.env.example`, and point `CORS_ORIGINS` at the
portal's domain.

### Why the install command forces dev dependencies

`installCommand` is `npm install --include=dev`, not plain `npm install`.

Setting `NODE_ENV=production` — which you want, so the app does not leak OTP codes in responses —
makes npm skip `devDependencies`. `@nestjs/cli` provides the `nest` binary the build needs and
`typescript` provides the compiler, and both are dev dependencies. Without the flag the install
drops from 582 packages to 322 and the build dies with `nest: command not found`.

### Why the entry point is JavaScript

`api/[[...slug]].js` is deliberately plain JS that requires `dist/`, rather than TypeScript that
imports `src/`.

Vercel's Node builder compiles TypeScript with **esbuild**, and esbuild does not support
`emitDecoratorMetadata`. NestJS resolves constructor injection from the `design:paramtypes`
metadata that flag emits, so letting Vercel compile the app strips the DI wiring and every provider
fails to resolve at runtime. `npm run build` compiles with `tsc`, which does emit it; the entry
point only wraps the result.

The filename is an optional catch-all so Vercel's filesystem routing maps it to `/api` **and**
`/api/**`. `/api/v1/health` therefore reaches the function with its original URL intact, with no
dependence on rewrite semantics.

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
