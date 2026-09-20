# Cricket Turf Booking — V1

A booking system for a business running three cricket turfs. Customers book without an
account; the owner verifies UPI payments by hand and confirms over WhatsApp.

Next.js 15 (App Router) · TypeScript · Tailwind · MongoDB Atlas · S3-compatible storage.

---

## The rule this system exists to enforce

**Two customers can never reserve overlapping time at the same ground on the same date.**

Everything else is arranged around that.

### How it is enforced

Time is modelled as **atomic units** — one document per `(locationId, date, startMin)`
in `slotUnits`, carrying a **unique index** on exactly that triple. A customer-facing
"5–9 PM" booking owns four one-hour units.

A unit is claimed with a *conditional upsert* whose filter matches only a free unit:

```js
{ locationId, date, startMin,
  $or: [ { status: "AVAILABLE" },
         { status: "HELD", holdUntil: { $lte: now } } ] }   // expired hold = free
```

Three outcomes, all decided by MongoDB rather than by application code:

| Unit state | What happens |
|---|---|
| no document yet | upsert inserts → claimed (a racing twin hits `E11000` and loses) |
| `AVAILABLE`, or `HELD` and expired | filter matches → claimed |
| `HELD` (live) / `PENDING` / `BOOKED` / `BLOCKED` | filter misses → upsert tries to insert → **`E11000`** → conflict |

All units of a multi-hour request are claimed inside **one transaction**, so the
operation is all-or-nothing: a conflict on the last hour rolls the earlier ones back
and no partial reservation can survive.

Two further consequences worth knowing:

- **Expired holds need no cron job.** Availability treats `HELD && holdUntil <= now`
  as free by *query predicate*. `cleanupExpiredHolds()` exists but correctness never
  depends on it running.
- **Intervals are half-open, `[start, end)`.** So `5–7` and `7–9` are adjacent and both
  succeed, while `5–7` and `6–8` share the 6–7 unit and only one can win.

Transactions require a replica set. Every Atlas cluster is one; a standalone `mongod`
is not, and the app logs a specific error if it is pointed at one.

---

## Getting started

```bash
npm install
cp .env.example .env.local     # then fill it in
npm run seed                   # 3 locations, hours and price bands — no fake bookings
ADMIN_USERNAME=owner ADMIN_PASSWORD='a-long-password' npm run create-admin
npm run dev
```

- Customer site: <http://localhost:3000>
- Staff sign-in: <http://localhost:3000/admin/login>

Generate the session secret with:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

### Payment screenshot storage

MongoDB never stores the image, only its object key. The image is reachable solely
through `/api/admin/bookings/[id]/screenshot`, which checks the admin session first.

**Leave `STORAGE_*` blank for local development.** Screenshots are then written to
`./.storage` — gitignored, outside `public/`, never served as a static asset — and
streamed back through that same authenticated route. No account, no bucket, no card.

This does **not** survive a serverless deploy: Vercel and Lambda give each instance an
ephemeral filesystem, so an uploaded screenshot would vanish. For production, point
`STORAGE_*` at a **private** S3-compatible bucket and the same code switches to signed
URLs that expire in five minutes:

| | Free tier | Card needed | Notes |
|---|---|---|---|
| Local disk | unlimited | no | development only, not serverless-safe |
| Supabase Storage | 1 GB | no | S3-compatible endpoint, drop-in |
| Cloudflare R2 | 10 GB, never expires | usually yes | zero egress fees, best for production |
| AWS S3 | 5 GB for 12 months | yes | expires after a year |

Switching is env-only — no code change.

---

## How a booking moves

```
customer picks slots
        │
        ▼
  HELD  (10 min, server-enforced; token is 256 random bits, only its hash is stored)
        │  submits name, phone, payment screenshot
        ▼
 PENDING ──── admin verifies payment ────▶ CONFIRMED ──▶ slots BOOKED
        │                                      │
        └──── admin rejects ──▶ REJECTED       └──▶ "Confirm via WhatsApp" (pre-filled,
                   │                                  the admin presses send)
                   ▼
            slots released — but a BLOCKED slot stays blocked
```

A `BLOCKED` slot and a `REJECTED` booking are deliberately different things: rejecting a
customer frees their slots, blocking closes the turf. Rejecting never unblocks.

---

## Guarantees, and where they live

| Guarantee | Enforced in |
|---|---|
| No overlapping reservations | unique index + conditional upsert, `lib/booking/service.ts` |
| Multi-hour holds are all-or-nothing | MongoDB transaction, same file |
| Expired holds free themselves | `liveStatus()` predicate, no job required |
| The browser cannot set the price | price recomputed from `slotConfigurations` on submit |
| The browser cannot set booking or payment status | neither field is in `bookingSubmitSchema` |
| A hold can only be submitted by its owner | 256-bit token in an httpOnly cookie; only the SHA-256 lives in the DB |
| Double click / retry cannot double-book | submitting a spent hold returns the original booking |
| Past and out-of-window dates are refused | `assertBookableDate()`, server-side |
| A slot that already started is not bookable | compared against the IST instant, not the browser clock |
| Confirmed bookings cannot be blocked over | `blockSlots` / `blockDay` refuse, even with `force` |
| Payment screenshots are never public | private bucket + session-checked 5-minute signed URL |
| Admin endpoints are individually authorised | `requireAdmin()` in every route, not just the layout |
| Login cannot be brute-forced | per-IP and per-account counters in MongoDB with a TTL index |

### Time

The business runs on **Asia/Kolkata**, which has no DST, so a fixed +05:30 offset is used
rather than `Intl` round-tripping. Dates are `"YYYY-MM-DD"` strings in IST and times are
integer minutes-of-day; every stored timestamp is UTC. See `lib/time.ts`.

### Money

A booking stores its own `amount` and `priceBreakdown`. Repricing the schedule never
touches historical bookings. Multi-hour price = sum of the hours, so price bands never
have to be duplicated per duration.

---

## Layout

```
src/
  app/
    page.tsx                landing
    book/                   customer booking flow
    booking/success/        submitted confirmation (read via the caller's own cookie)
    admin/login/            staff sign-in
    admin/(dashboard)/      dashboard · bookings · availability · locations · settings
    api/                    public: locations, availability, holds, uploads, bookings
                            admin:  bookings, blocks, locations, config, settings, stats, day
  components/{customer,admin,ui}/
  lib/
    booking/service.ts      the booking engine — all state transitions live here
    booking/schedule.ts     slot template, range resolution, pricing
    db.ts  auth.ts  storage.ts  time.ts  validation.ts  rate-limit.ts  whatsapp.ts
scripts/                    seed · create-admin
tests/                      unit + integration incl. concurrency
```

Business logic lives in `lib/booking/service.ts`. API routes validate, authorise and
translate errors; they do not re-implement any rules. UI components never talk to Mongo.

---

## Seeing it work

```bash
npm run dev                 # one terminal
npm run demo                # another — fires simultaneous requests at one slot
npm run demo -- --clean     # remove everything the demo created
```

The demo collides four customers on the same hour, then tries an overlapping range,
an adjacent range and the same hour at a different ground, and prints who won and why.
It leaves one PENDING booking behind so the admin verify → confirm flow can be walked
through in the UI.

Its screenshot will not open until `STORAGE_*` is configured — the demo submits a
placeholder key rather than uploading anything.

## Tests

```bash
npm run test:unit   # pure logic, no database
npm test            # everything, needs MONGODB_URI pointed at a replica set
npm run typecheck
npm run lint
```

`npm test` writes to `<MONGODB_DB>_test` and clears it between cases, so it never touches
real data. It covers the whole lifecycle plus the races that matter:

- three simultaneous identical requests → exactly one wins
- `5–7` vs `6–8` → one wins, the loser leaves nothing behind
- `5–7` vs `7–9` → both succeed
- eight-way burst → one winner, no duplicate unit documents
- expired hold cannot be submitted, and a new customer can take the slot over
- rejecting releases slots; blocking survives a rejection
- blocking a confirmed booking is refused even when forced
- final pass asserting no duplicate reservation, orphan hold, or booking without slots

---

## Deliberately not built

Customer accounts, booking history, cancellation, refunds, rescheduling, a cart, an
online payment gateway, automated WhatsApp sending, and WebSockets.

Availability is fetched on location/date change, when the tab regains focus, and
re-verified atomically at hold time — which is what actually prevents double booking. A
live socket would not add a guarantee, only moving parts.
