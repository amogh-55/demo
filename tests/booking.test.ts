/**
 * Integration and concurrency tests against a real MongoDB replica set.
 *
 * Transactions need a replica set, which every Atlas cluster is. Point
 * MONGODB_URI at a test cluster and run `npm test`; the suite writes to
 * `<MONGODB_DB>_test` and clears it between cases, never touching real data.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { ObjectId } from "mongodb";
import { config as loadEnv } from "../scripts/env";

loadEnv();

const HAS_DB = Boolean(process.env.MONGODB_URI);
if (!HAS_DB) {
  console.warn(
    "\n⚠  Skipping database tests: MONGODB_URI is not set.\n" +
      "   Copy .env.example to .env.local and point it at a MongoDB replica set (Atlas works),\n" +
      "   then run `npm test` again to exercise the concurrency guarantees.\n",
  );
}

// The test database is always a separate name, so a misconfigured URI still cannot
// wipe production data.
process.env.MONGODB_DB = `${process.env.MONGODB_DB || "turf_booking"}_test`;

const IST_OFFSET = 330 * 60_000;
// Fixed ids keep the fixture idempotent, so re-running the suite never trips the
// unique slug index with a fresh ObjectId for the same location.
const LOCATION_ID = new ObjectId("000000000000000000000001");
const OTHER_LOCATION_ID = new ObjectId("000000000000000000000002");

const SCHEDULE = {
  slotMinutes: 60,
  openMin: 17 * 60, // 5 PM
  closeMin: 23 * 60, // 11 PM
  bookingWindowDays: 30,
  holdMinutes: 10,
  priceRules: [
    { fromMin: 17 * 60, toMin: 19 * 60, price: 800 },
    { fromMin: 19 * 60, toMin: 23 * 60, price: 900 },
  ],
};

/** A date far enough ahead to stay inside the booking window and never be "past". */
function futureDate(daysAhead = 5): string {
  return new Date(Date.now() + IST_OFFSET + daysAhead * 86_400_000).toISOString().slice(0, 10);
}

function pastDate(daysBack = 2): string {
  return new Date(Date.now() + IST_OFFSET - daysBack * 86_400_000).toISOString().slice(0, 10);
}

type Db = Awaited<ReturnType<typeof import("../src/lib/db")["getDb"]>>;
type Service = typeof import("../src/lib/booking/service");
type Collections = typeof import("../src/lib/db")["collections"];

let db: Db;
let service: Service;
let collections: Collections;
let closeClient: () => Promise<void>;

const ADMIN = { username: "tester" };

/** Accepts the booking's outstanding screenshot for `amount` (default: in full). */
async function acceptPayment(
  booking: { _id: ObjectId; payments: Array<{ id: string; status: string }>; amount: number },
  amount?: number,
) {
  const attempt = booking.payments.find((p) => p.status === "PENDING")!;
  return service.reviewPayment({
    bookingId: booking._id,
    attemptId: attempt.id,
    accepted: true,
    amount: amount ?? booking.amount,
    admin: ADMIN,
  });
}

const SCREENSHOT = "payment-screenshots/test/shot.jpg";

describe("booking engine", { skip: !HAS_DB }, () => {
  before(async () => {
    const dbModule = await import("../src/lib/db");
    service = await import("../src/lib/booking/service");
    collections = dbModule.collections;
    db = await dbModule.getDb();
    closeClient = () => dbModule.getMongoClient().close();

    // The suite owns this database outright, so it starts from a clean fixture.
    await Promise.all([
      collections.locations(db).deleteMany({}),
      collections.slotConfigs(db).deleteMany({}),
    ]);

    const now = new Date();
    for (const [id, name, active] of [
      [LOCATION_ID, "Test Turf", true],
      [OTHER_LOCATION_ID, "Closed Turf", false],
    ] as const) {
      await collections.locations(db).replaceOne(
        { _id: id },
        {
          name,
          slug: name.toLowerCase().replace(/\s+/g, "-"),
          address: "Test address",
          description: "",
          image: "",
          phone: "9876543210",
          active,
          createdAt: now,
          updatedAt: now,
        },
        { upsert: true },
      );
      await collections.slotConfigs(db).replaceOne(
        { locationId: id },
        { locationId: id, ...SCHEDULE, updatedAt: now },
        { upsert: true },
      );
    }
  });

  beforeEach(async () => {
    await Promise.all([
      collections.slotUnits(db).deleteMany({}),
      collections.bookings(db).deleteMany({}),
      collections.dayBlocks(db).deleteMany({}),
      collections.auditLogs(db).deleteMany({}),
    ]);
  });

  after(async () => {
    if (closeClient) await closeClient();
  });

  /* ── Availability ──────────────────────────────────────────────────── */

  describe("availability", () => {
    it("lists every configured slot as available on an empty day", async () => {
      const result = await service.getAvailability(LOCATION_ID, futureDate());
      assert.equal(result.units.length, 6); // 5 PM – 11 PM in one-hour units
      assert.ok(result.units.every((u) => u.status === "AVAILABLE"));
      assert.equal(result.units[0]!.price, 800);
      assert.equal(result.units.at(-1)!.price, 900);
    });

    it("never exposes customer data", async () => {
      await service.createHold({ locationId: LOCATION_ID, date: futureDate(), startMin: 1020, endMin: 1080 });
      const result = await service.getAvailability(LOCATION_ID, futureDate());
      const serialised = JSON.stringify(result);
      assert.ok(!serialised.includes("customerName"));
      assert.ok(!serialised.includes("holdToken"));
      assert.ok(!serialised.includes("9876543210"));
    });

    it("refuses past dates", async () => {
      await assert.rejects(() => service.getAvailability(LOCATION_ID, pastDate()), /already passed/i);
    });

    it("refuses dates beyond the booking window", async () => {
      await assert.rejects(() => service.getAvailability(LOCATION_ID, futureDate(45)), /days in advance/i);
    });

    it("refuses an inactive location", async () => {
      await assert.rejects(() => service.getAvailability(OTHER_LOCATION_ID, futureDate()), /not accepting bookings/i);
    });

    it("marks slots whose start time has already passed as PAST, keeping later ones bookable", async () => {
      const today = new Date(Date.now() + IST_OFFSET).toISOString().slice(0, 10);
      // Pretend it is 8:30 PM IST today.
      const now = new Date(new Date(`${today}T20:30:00.000Z`).getTime() - IST_OFFSET);
      const result = await service.getAvailability(LOCATION_ID, today, now);

      const fivePm = result.units.find((u) => u.startMin === 1020)!;
      const tenPm = result.units.find((u) => u.startMin === 22 * 60)!;
      assert.equal(fivePm.status, "PAST", "a slot that already started must not be bookable");
      assert.equal(tenPm.status, "AVAILABLE", "same-day booking must still work for later slots");
    });
  });

  /* ── Holds ─────────────────────────────────────────────────────────── */

  describe("holds", () => {
    it("holds a single hour and prices it from the schedule", async () => {
      const date = futureDate();
      const hold = await service.createHold({ locationId: LOCATION_ID, date, startMin: 1020, endMin: 1080 });
      assert.equal(hold.amount, 800);
      assert.equal(hold.holdToken.length, 64);

      const availability = await service.getAvailability(LOCATION_ID, date);
      assert.equal(availability.units.find((u) => u.startMin === 1020)!.status, "HELD");
    });

    it("holds every underlying unit of a multi-hour request", async () => {
      const date = futureDate();
      const hold = await service.createHold({ locationId: LOCATION_ID, date, startMin: 1020, endMin: 1260 }); // 5–9
      assert.equal(hold.amount, 800 + 800 + 900 + 900);

      const units = await collections.slotUnits(db).find({ locationId: LOCATION_ID, date }).toArray();
      assert.equal(units.length, 4);
      assert.ok(units.every((u) => u.status === "HELD"));
    });

    it("rejects a range that does not line up with the schedule", async () => {
      await assert.rejects(
        () => service.createHold({ locationId: LOCATION_ID, date: futureDate(), startMin: 1050, endMin: 1110 }),
        /not bookable/i,
      );
    });

    it("never persists the raw hold token", async () => {
      const date = futureDate();
      const hold = await service.createHold({ locationId: LOCATION_ID, date, startMin: 1020, endMin: 1080 });
      const unit = await collections.slotUnits(db).findOne({ locationId: LOCATION_ID, date, startMin: 1020 });
      assert.notEqual(unit!.holdTokenHash, hold.holdToken);
      assert.equal(unit!.holdTokenHash!.length, 64); // sha-256 hex
    });

    it("recovers a live hold from its token, so a refresh does not double-book", async () => {
      const date = futureDate();
      const hold = await service.createHold({ locationId: LOCATION_ID, date, startMin: 1020, endMin: 1140 });
      const recovered = await service.getHold(hold.holdToken);
      assert.equal(recovered?.startMin, 1020);
      assert.equal(recovered?.endMin, 1140);
      assert.equal(recovered?.amount, 1600);

      const units = await collections.slotUnits(db).countDocuments({ locationId: LOCATION_ID, date });
      assert.equal(units, 2, "recovery must not create more reservations");
    });

    it("releases a hold on request", async () => {
      const date = futureDate();
      const hold = await service.createHold({ locationId: LOCATION_ID, date, startMin: 1020, endMin: 1080 });
      await service.releaseHold(hold.holdToken);

      const availability = await service.getAvailability(LOCATION_ID, date);
      assert.equal(availability.units.find((u) => u.startMin === 1020)!.status, "AVAILABLE");
    });

    it("treats an expired hold as available without any cleanup job running", async () => {
      const date = futureDate();
      const hold = await service.createHold({ locationId: LOCATION_ID, date, startMin: 1020, endMin: 1080 });

      // Wind the hold's expiry into the past; the document still says HELD.
      await collections.slotUnits(db).updateOne(
        { holdTokenHash: { $ne: null }, date },
        { $set: { holdUntil: new Date(Date.now() - 60_000) } },
      );

      const stored = await collections.slotUnits(db).findOne({ date, startMin: 1020 });
      assert.equal(stored!.status, "HELD", "the stored row is deliberately left stale");

      const availability = await service.getAvailability(LOCATION_ID, date);
      assert.equal(availability.units.find((u) => u.startMin === 1020)!.status, "AVAILABLE");
      assert.equal(await service.getHold(hold.holdToken), null);
    });

    it("lets a new customer take over a slot whose hold expired", async () => {
      const date = futureDate();
      const first = await service.createHold({ locationId: LOCATION_ID, date, startMin: 1020, endMin: 1080 });
      await collections.slotUnits(db).updateMany({ date }, { $set: { holdUntil: new Date(Date.now() - 60_000) } });

      const second = await service.createHold({ locationId: LOCATION_ID, date, startMin: 1020, endMin: 1080 });
      assert.notEqual(second.holdToken, first.holdToken);

      // And the first customer can no longer submit against it.
      await assert.rejects(
        () =>
          service.submitBooking({
            holdToken: first.holdToken,
            customerName: "Late Larry",
            customerPhone: "9876543210",
            paymentScreenshotKey: SCREENSHOT,
          }),
        /expired|verify your slot hold/i,
      );
    });

    it("refuses to hold a slot on a blocked day", async () => {
      const date = futureDate();
      await service.blockDay({ locationId: LOCATION_ID, date, reason: "Festival", force: false, admin: ADMIN });
      await assert.rejects(
        () => service.createHold({ locationId: LOCATION_ID, date, startMin: 1020, endMin: 1080 }),
        /not taking bookings/i,
      );
    });

    it("refuses to hold an inactive location", async () => {
      await assert.rejects(
        () => service.createHold({ locationId: OTHER_LOCATION_ID, date: futureDate(), startMin: 1020, endMin: 1080 }),
        /not accepting bookings/i,
      );
    });

    it("refuses to hold a past date", async () => {
      await assert.rejects(
        () => service.createHold({ locationId: LOCATION_ID, date: pastDate(), startMin: 1020, endMin: 1080 }),
        /already passed/i,
      );
    });
  });

  /* ── Concurrency: the core guarantee ───────────────────────────────── */

  describe("concurrency", () => {
    it("lets exactly one of two simultaneous identical requests win", async () => {
      const date = futureDate();
      const results = await Promise.allSettled([
        service.createHold({ locationId: LOCATION_ID, date, startMin: 1020, endMin: 1140 }),
        service.createHold({ locationId: LOCATION_ID, date, startMin: 1020, endMin: 1140 }),
      ]);

      const won = results.filter((r) => r.status === "fulfilled");
      const lost = results.filter((r) => r.status === "rejected");
      assert.equal(won.length, 1, "exactly one request may hold the slot");
      assert.equal(lost.length, 1);
      assert.match((lost[0] as PromiseRejectedResult).reason.message, /just taken|another customer|try again/i);

      const units = await collections.slotUnits(db).find({ locationId: LOCATION_ID, date }).toArray();
      const hashes = new Set(units.map((u) => u.holdTokenHash));
      assert.equal(hashes.size, 1, "all held units must belong to the same hold");
      assert.equal(units.length, 2);
    });

    it("lets exactly one of two overlapping multi-hour requests win (5–7 vs 6–8)", async () => {
      const date = futureDate();
      const results = await Promise.allSettled([
        service.createHold({ locationId: LOCATION_ID, date, startMin: 1020, endMin: 1140 }), // 5–7
        service.createHold({ locationId: LOCATION_ID, date, startMin: 1080, endMin: 1200 }), // 6–8
      ]);

      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);

      // No partial reservation may survive the loser's rollback.
      const held = await collections
        .slotUnits(db)
        .find({ locationId: LOCATION_ID, date, status: "HELD", holdUntil: { $gt: new Date() } })
        .toArray();
      const hashes = new Set(held.map((u) => u.holdTokenHash));
      assert.equal(hashes.size, 1, "a rolled-back hold must leave no units behind");
      assert.equal(held.length, 2, "the winner owns exactly its own two hours");
    });

    it("allows adjacent bookings because intervals are half-open", async () => {
      const date = futureDate();
      const results = await Promise.allSettled([
        service.createHold({ locationId: LOCATION_ID, date, startMin: 1020, endMin: 1140 }), // [5,7)
        service.createHold({ locationId: LOCATION_ID, date, startMin: 1140, endMin: 1260 }), // [7,9)
      ]);

      assert.equal(results.filter((r) => r.status === "fulfilled").length, 2, "5–7 and 7–9 do not overlap");
      const units = await collections.slotUnits(db).countDocuments({ locationId: LOCATION_ID, date, status: "HELD" });
      assert.equal(units, 4);
    });

    it("keeps the database consistent under a burst of competing requests", async () => {
      const date = futureDate();
      const attempts = Array.from({ length: 8 }, () =>
        service.createHold({ locationId: LOCATION_ID, date, startMin: 1020, endMin: 1140 }),
      );
      const results = await Promise.allSettled(attempts);

      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1, "only one winner out of eight");

      const units = await collections.slotUnits(db).find({ locationId: LOCATION_ID, date }).toArray();
      assert.equal(units.length, 2, "no duplicate slot-unit documents");
      assert.equal(new Set(units.map((u) => `${u.startMin}`)).size, 2, "no duplicate unit identities");
      assert.equal(new Set(units.map((u) => u.holdTokenHash)).size, 1, "one owner only");
    });

    it("refuses a second booking on an already confirmed slot", async () => {
      const date = futureDate();
      const hold = await service.createHold({ locationId: LOCATION_ID, date, startMin: 1020, endMin: 1080 });
      const booking = await service.submitBooking({
        holdToken: hold.holdToken,
        customerName: "Ravi Kumar",
        customerPhone: "9876543210",
        paymentScreenshotKey: SCREENSHOT,
      });
      await acceptPayment(booking);
      await service.confirmBooking(booking._id, ADMIN);

      await assert.rejects(
        () => service.createHold({ locationId: LOCATION_ID, date, startMin: 1020, endMin: 1080 }),
        /just taken|another customer/i,
      );
    });
  });

  /* ── Submission ────────────────────────────────────────────────────── */

  describe("booking submission", () => {
    async function holdAndSubmit(date = futureDate(), startMin = 1020, endMin = 1140) {
      const hold = await service.createHold({ locationId: LOCATION_ID, date, startMin, endMin });
      const booking = await service.submitBooking({
        holdToken: hold.holdToken,
        customerName: "Ravi Kumar",
        customerPhone: "9876543210",
        paymentScreenshotKey: SCREENSHOT,
      });
      return { hold, booking };
    }

    it("creates a PENDING booking owning every unit, with a price snapshot", async () => {
      const date = futureDate();
      const { booking } = await holdAndSubmit(date);

      assert.equal(booking.status, "PENDING");
      assert.equal(booking.paymentVerificationStatus, "PENDING");
      assert.equal(booking.amount, 1600);
      assert.deepEqual(booking.unitStarts, [1020, 1080]);
      assert.match(booking.reference, /^TURF-[2-9A-HJ-NP-Z]{6}$/);

      const units = await collections.slotUnits(db).find({ bookingId: booking._id }).toArray();
      assert.equal(units.length, 2);
      assert.ok(units.every((u) => u.status === "PENDING"));
    });

    it("keeps the original price after the schedule is repriced", async () => {
      const { booking } = await holdAndSubmit();
      await collections.slotConfigs(db).updateOne(
        { locationId: LOCATION_ID },
        { $set: { priceRules: [{ fromMin: 0, toMin: 1440, price: 5000 }] } },
      );

      const stored = await collections.bookings(db).findOne({ _id: booking._id });
      assert.equal(stored!.amount, 1600, "historic bookings must not be repriced");

      // Restore the schedule for the remaining tests.
      await collections.slotConfigs(db).updateOne(
        { locationId: LOCATION_ID },
        { $set: { priceRules: SCHEDULE.priceRules } },
      );
    });

    it("returns the same booking when the same hold is submitted twice", async () => {
      const date = futureDate();
      const hold = await service.createHold({ locationId: LOCATION_ID, date, startMin: 1020, endMin: 1080 });
      const payload = {
        holdToken: hold.holdToken,
        customerName: "Ravi Kumar",
        customerPhone: "9876543210",
        paymentScreenshotKey: SCREENSHOT,
      };

      const first = await service.submitBooking(payload);
      const second = await service.submitBooking(payload);

      assert.equal(first.reference, second.reference, "a retry must not create a second booking");
      assert.equal(await collections.bookings(db).countDocuments({}), 1);
    });

    it("survives two simultaneous submissions of one hold", async () => {
      const date = futureDate();
      const hold = await service.createHold({ locationId: LOCATION_ID, date, startMin: 1020, endMin: 1080 });
      const payload = {
        holdToken: hold.holdToken,
        customerName: "Ravi Kumar",
        customerPhone: "9876543210",
        paymentScreenshotKey: SCREENSHOT,
      };

      const results = await Promise.allSettled([service.submitBooking(payload), service.submitBooking(payload)]);
      const created = results.filter((r) => r.status === "fulfilled");
      assert.ok(created.length >= 1);
      assert.equal(await collections.bookings(db).countDocuments({}), 1, "double click must not double book");
    });

    it("refuses submission after the hold expired, creating nothing", async () => {
      const date = futureDate();
      const hold = await service.createHold({ locationId: LOCATION_ID, date, startMin: 1020, endMin: 1080 });
      await collections.slotUnits(db).updateMany({ date }, { $set: { holdUntil: new Date(Date.now() - 1000) } });

      await assert.rejects(
        () =>
          service.submitBooking({
            holdToken: hold.holdToken,
            customerName: "Ravi Kumar",
            customerPhone: "9876543210",
            paymentScreenshotKey: SCREENSHOT,
          }),
        /expired/i,
      );
      assert.equal(await collections.bookings(db).countDocuments({}), 0, "no orphan booking may be created");
    });

    it("refuses an unknown or forged hold token", async () => {
      await assert.rejects(
        () =>
          service.submitBooking({
            holdToken: "f".repeat(64),
            customerName: "Mallory",
            customerPhone: "9876543210",
            paymentScreenshotKey: SCREENSHOT,
          }),
        /verify your slot hold/i,
      );
    });

    it("stops one customer submitting another customer's hold", async () => {
      const date = futureDate();
      const victim = await service.createHold({ locationId: LOCATION_ID, date, startMin: 1020, endMin: 1080 });
      const attacker = await service.createHold({ locationId: LOCATION_ID, date, startMin: 1140, endMin: 1200 });

      const booking = await service.submitBooking({
        holdToken: attacker.holdToken,
        customerName: "Mallory",
        customerPhone: "9876543210",
        paymentScreenshotKey: SCREENSHOT,
      });

      // The attacker's booking owns only the attacker's own units.
      assert.deepEqual(booking.unitStarts, [1140]);
      const victimUnit = await collections.slotUnits(db).findOne({ date, startMin: 1020 });
      assert.equal(victimUnit!.holdTokenHash !== null, true);
      assert.equal(victimUnit!.bookingId, null, "the victim's hold must be untouched");
      assert.notEqual(victim.holdToken, attacker.holdToken);
    });

    it("refuses submission once the day has been blocked", async () => {
      const date = futureDate();
      const hold = await service.createHold({ locationId: LOCATION_ID, date, startMin: 1020, endMin: 1080 });
      await service.blockDay({ locationId: LOCATION_ID, date, reason: "Storm", force: true, admin: ADMIN });

      await assert.rejects(
        () =>
          service.submitBooking({
            holdToken: hold.holdToken,
            customerName: "Ravi Kumar",
            customerPhone: "9876543210",
            paymentScreenshotKey: SCREENSHOT,
          }),
        /not taking bookings|expired|verify your slot hold/i,
      );
    });
  });

  /* ── Admin transitions ─────────────────────────────────────────────── */

  describe("admin actions", () => {
    async function pendingBooking(date = futureDate(), startMin = 1020, endMin = 1140) {
      const hold = await service.createHold({ locationId: LOCATION_ID, date, startMin, endMin });
      return service.submitBooking({
        holdToken: hold.holdToken,
        customerName: "Ravi Kumar",
        customerPhone: "9876543210",
        paymentScreenshotKey: SCREENSHOT,
      });
    }

    it("will not confirm before the payment is verified", async () => {
      const booking = await pendingBooking();
      await assert.rejects(() => service.confirmBooking(booking._id, ADMIN), /outstanding|verify the payment/i);
    });

    it("confirms a verified booking and marks its slots BOOKED", async () => {
      const date = futureDate();
      const booking = await pendingBooking(date);
      await acceptPayment(booking);
      const confirmed = await service.confirmBooking(booking._id, ADMIN);

      assert.equal(confirmed.status, "CONFIRMED");
      const units = await collections.slotUnits(db).find({ bookingId: booking._id }).toArray();
      assert.ok(units.every((u) => u.status === "BOOKED"));

      const availability = await service.getAvailability(LOCATION_ID, date);
      assert.equal(availability.units.find((u) => u.startMin === 1020)!.status, "BOOKED");
    });

    it("is idempotent when confirm is clicked twice", async () => {
      const booking = await pendingBooking();
      await acceptPayment(booking);
      await service.confirmBooking(booking._id, ADMIN);
      const again = await service.confirmBooking(booking._id, ADMIN);
      assert.equal(again.status, "CONFIRMED");
      assert.equal(await collections.bookings(db).countDocuments({}), 1);
    });

    it("rejects a booking and releases its slots", async () => {
      const date = futureDate();
      const booking = await pendingBooking(date);
      const rejected = await service.rejectBooking(booking._id, "Payment not received", ADMIN);

      assert.equal(rejected.status, "REJECTED");
      assert.equal(rejected.rejectionReason, "Payment not received");

      const availability = await service.getAvailability(LOCATION_ID, date);
      assert.equal(availability.units.find((u) => u.startMin === 1020)!.status, "AVAILABLE");

      // And the freed slot can genuinely be taken by someone else.
      const next = await service.createHold({ locationId: LOCATION_ID, date, startMin: 1020, endMin: 1080 });
      assert.ok(next.holdToken);
    });

    it("cannot confirm a booking that was already rejected", async () => {
      const booking = await pendingBooking();
      await service.rejectBooking(booking._id, "Payment not received", ADMIN);
      await assert.rejects(() => service.confirmBooking(booking._id, ADMIN), /rejected/i);
    });

    it("records the payment decision on the booking timeline", async () => {
      const booking = await pendingBooking();
      const attempt = booking.payments.find((p) => p.status === "PENDING")!;
      await service.reviewPayment({
        bookingId: booking._id,
        attemptId: attempt.id,
        accepted: false,
        note: "Screenshot is unclear",
        admin: ADMIN,
      });
      const stored = await collections.bookings(db).findOne({ _id: booking._id });

      assert.equal(stored!.paymentVerificationStatus, "REJECTED");
      assert.ok(stored!.timeline.some((t) => t.event === "PAYMENT_REJECTED"));
      assert.ok(stored!.timeline.some((t) => t.event === "BOOKING_SUBMITTED"));
    });

    it("records that WhatsApp was opened, never that a message was sent", async () => {
      const booking = await pendingBooking();
      await service.recordWhatsappOpened(booking._id, "CONFIRM", ADMIN);
      const stored = await collections.bookings(db).findOne({ _id: booking._id });
      assert.ok(stored!.timeline.some((t) => t.event === "WHATSAPP_CONFIRM_OPENED"));
      assert.ok(!stored!.timeline.some((t) => t.event.includes("SENT")));
    });
  });

  /* ── Blocking ──────────────────────────────────────────────────────── */

  describe("blocking", () => {
    it("blocks free slots and stops customers booking them", async () => {
      const date = futureDate();
      const outcome = await service.blockSlots({
        locationId: LOCATION_ID,
        date,
        startMin: 1020,
        endMin: 1260,
        reason: "Tournament",
        force: false,
        admin: ADMIN,
      });
      assert.equal(outcome.blocked, 4);

      const availability = await service.getAvailability(LOCATION_ID, date);
      assert.equal(availability.units.find((u) => u.startMin === 1020)!.status, "BLOCKED");
      // A closed ground says so, rather than blaming an imaginary other customer.
      await assert.rejects(
        () => service.createHold({ locationId: LOCATION_ID, date, startMin: 1020, endMin: 1080 }),
        /ground is closed/i,
      );
    });

    it("refuses to block a date that has already passed", async () => {
      const date = pastDate();
      await assert.rejects(
        () =>
          service.blockSlots({
            locationId: LOCATION_ID,
            date,
            startMin: 1020,
            endMin: 1080,
            reason: "Tournament",
            force: false,
            admin: ADMIN,
          }),
        /already passed/i,
      );
      await assert.rejects(
        () => service.blockDay({ locationId: LOCATION_ID, date, reason: "Festival", force: false, admin: ADMIN }),
        /already passed/i,
      );
      // Nothing was written on the way to the rejection.
      assert.equal(await collections.dayBlocks(db).countDocuments({ locationId: LOCATION_ID, date }), 0);
      assert.equal(await collections.slotUnits(db).countDocuments({ locationId: LOCATION_ID, date }), 0);
    });

    it("still re-opens a past date that was blocked before the guard existed", async () => {
      const date = pastDate();
      await collections.dayBlocks(db).insertOne({
        locationId: LOCATION_ID,
        date,
        reason: "Legacy",
        blockedBy: "tester",
        blockedAt: new Date(),
      } as never);
      assert.equal(await service.unblockDay(LOCATION_ID, date), true);
    });

    it("re-opens blocked slots", async () => {
      const date = futureDate();
      await service.blockSlots({ locationId: LOCATION_ID, date, startMin: 1020, endMin: 1140, reason: "Rain", force: false, admin: ADMIN });
      const unblocked = await service.unblockSlots({ locationId: LOCATION_ID, date, startMin: 1020, endMin: 1140 });
      assert.equal(unblocked, 2);

      const availability = await service.getAvailability(LOCATION_ID, date);
      assert.equal(availability.units.find((u) => u.startMin === 1020)!.status, "AVAILABLE");
    });

    it("warns instead of blocking when a live hold is in the way", async () => {
      const date = futureDate();
      await service.createHold({ locationId: LOCATION_ID, date, startMin: 1080, endMin: 1200 }); // 6–8

      const outcome = await service.blockSlots({
        locationId: LOCATION_ID,
        date,
        startMin: 1020,
        endMin: 1140, // 5–7 overlaps the hold's 6–7
        reason: "Tournament",
        force: false,
        admin: ADMIN,
      });

      assert.equal(outcome.blocked, 0, "nothing may be blocked before the admin sees the conflict");
      assert.equal(outcome.conflicts.length, 1);
      assert.equal(outcome.conflicts[0]!.startMin, 1080);
    });

    /**
     * A block can cut across only part of a booking. Rejecting the booking has to
     * hand back every hour it still owns, or the hours outside the block stay
     * reserved for a booking that no longer exists and can never be sold again.
     */
    it("releases the hours outside the block when a straddling booking is rejected", async () => {
      const date = futureDate();
      const hold = await service.createHold({ locationId: LOCATION_ID, date, startMin: 1020, endMin: 1140 }); // 5–7
      await service.submitBooking({
        holdToken: hold.holdToken,
        customerName: "Ravi Kumar",
        customerPhone: "9876543210",
        paymentScreenshotKey: SCREENSHOT,
      });

      // Block 5–6 only: the booking's 6–7 hour sits outside the blocked range.
      const outcome = await service.blockSlots({
        locationId: LOCATION_ID,
        date,
        startMin: 1020,
        endMin: 1080,
        reason: "Emergency maintenance",
        force: true,
        admin: ADMIN,
      });
      assert.equal(outcome.blocked, 1);

      const availability = await service.getAvailability(LOCATION_ID, date);
      assert.equal(availability.units.find((u) => u.startMin === 1020)!.status, "BLOCKED");
      assert.equal(
        availability.units.find((u) => u.startMin === 1080)!.status,
        "AVAILABLE",
        "the hour outside the block must go back on sale, not stay stranded",
      );

      // And it must genuinely be bookable, not merely look available.
      const next = await service.createHold({ locationId: LOCATION_ID, date, startMin: 1080, endMin: 1140 });
      assert.equal(next.startMin, 1080);
    });

    it("blocks over a pending request only when forced, and rejects that booking explicitly", async () => {
      const date = futureDate();
      const hold = await service.createHold({ locationId: LOCATION_ID, date, startMin: 1020, endMin: 1080 });
      const booking = await service.submitBooking({
        holdToken: hold.holdToken,
        customerName: "Ravi Kumar",
        customerPhone: "9876543210",
        paymentScreenshotKey: SCREENSHOT,
      });

      const outcome = await service.blockSlots({
        locationId: LOCATION_ID,
        date,
        startMin: 1020,
        endMin: 1080,
        reason: "Emergency maintenance",
        force: true,
        admin: ADMIN,
      });
      assert.equal(outcome.blocked, 1);

      const stored = await collections.bookings(db).findOne({ _id: booking._id });
      assert.equal(stored!.status, "REJECTED", "the customer's request must not vanish silently");
      assert.match(stored!.rejectionReason!, /Emergency maintenance/);
    });

    it("refuses outright to block a confirmed booking", async () => {
      const date = futureDate();
      const hold = await service.createHold({ locationId: LOCATION_ID, date, startMin: 1020, endMin: 1080 });
      const booking = await service.submitBooking({
        holdToken: hold.holdToken,
        customerName: "Ravi Kumar",
        customerPhone: "9876543210",
        paymentScreenshotKey: SCREENSHOT,
      });
      await acceptPayment(booking);
      await service.confirmBooking(booking._id, ADMIN);

      await assert.rejects(
        () =>
          service.blockSlots({
            locationId: LOCATION_ID,
            date,
            startMin: 1020,
            endMin: 1140,
            reason: "Tournament",
            force: true, // even forcing must not destroy a confirmed booking
            admin: ADMIN,
          }),
        /confirmed bookings/i,
      );

      const stored = await collections.bookings(db).findOne({ _id: booking._id });
      assert.equal(stored!.status, "CONFIRMED");
      const unit = await collections.slotUnits(db).findOne({ date, startMin: 1020 });
      assert.equal(unit!.status, "BOOKED");
    });

    it("blocks a whole day with a single document", async () => {
      const date = futureDate();
      await service.blockDay({ locationId: LOCATION_ID, date, reason: "Festival", force: false, admin: ADMIN });

      assert.equal(await collections.dayBlocks(db).countDocuments({ locationId: LOCATION_ID, date }), 1);
      assert.equal(
        await collections.slotUnits(db).countDocuments({ locationId: LOCATION_ID, date }),
        0,
        "a day block must not materialise one row per slot",
      );

      const availability = await service.getAvailability(LOCATION_ID, date);
      assert.equal(availability.dayBlocked, true);
      assert.ok(availability.units.every((u) => u.status === "BLOCKED"));
    });

    it("refuses a day block that would bury a confirmed booking", async () => {
      const date = futureDate();
      const hold = await service.createHold({ locationId: LOCATION_ID, date, startMin: 1020, endMin: 1080 });
      const booking = await service.submitBooking({
        holdToken: hold.holdToken,
        customerName: "Ravi Kumar",
        customerPhone: "9876543210",
        paymentScreenshotKey: SCREENSHOT,
      });
      await acceptPayment(booking);
      await service.confirmBooking(booking._id, ADMIN);

      await assert.rejects(
        () => service.blockDay({ locationId: LOCATION_ID, date, reason: "Festival", force: true, admin: ADMIN }),
        /confirmed bookings/i,
      );
    });

    it("re-opens a blocked day", async () => {
      const date = futureDate();
      await service.blockDay({ locationId: LOCATION_ID, date, reason: "Festival", force: false, admin: ADMIN });
      assert.equal(await service.unblockDay(LOCATION_ID, date), true);

      const availability = await service.getAvailability(LOCATION_ID, date);
      assert.equal(availability.dayBlocked, false);
      assert.ok(availability.units.every((u) => u.status === "AVAILABLE"));
    });

    it("does not reopen a blocked slot when a booking on a different slot is rejected", async () => {
      const date = futureDate();
      await service.blockSlots({ locationId: LOCATION_ID, date, startMin: 1140, endMin: 1200, reason: "Nets", force: false, admin: ADMIN });

      const hold = await service.createHold({ locationId: LOCATION_ID, date, startMin: 1020, endMin: 1080 });
      const booking = await service.submitBooking({
        holdToken: hold.holdToken,
        customerName: "Ravi Kumar",
        customerPhone: "9876543210",
        paymentScreenshotKey: SCREENSHOT,
      });
      await service.rejectBooking(booking._id, "Payment not received", ADMIN);

      const blocked = await collections.slotUnits(db).findOne({ date, startMin: 1140 });
      assert.equal(blocked!.status, "BLOCKED", "a rejected booking must not unblock the turf");
    });
  });

  /* ── Partial payments: the 1400-against-1600 case ──────────────────── */

  describe("partial payments", () => {
    async function pendingBooking(date = futureDate(), startMin = 1020, endMin = 1140) {
      const hold = await service.createHold({ locationId: LOCATION_ID, date, startMin, endMin });
      return service.submitBooking({
        holdToken: hold.holdToken,
        customerName: "Ravi Kumar",
        customerPhone: "9876543210",
        paymentScreenshotKey: SCREENSHOT,
      });
    }

    it("marks a short payment PARTIAL and keeps the slots reserved", async () => {
      const date = futureDate();
      const booking = await pendingBooking(date); // 5-7 PM costs 1600
      const short = await acceptPayment(booking, 1400);

      assert.equal(short.paymentVerificationStatus, "PARTIAL");
      assert.equal(short.amountPaid, 1400);
      assert.equal(short.amount - short.amountPaid, 200);
      assert.equal(short.status, "PENDING", "a shortfall must not change the booking status");

      // The crucial part: nobody else may take the slots.
      const availability = await service.getAvailability(LOCATION_ID, date);
      assert.equal(availability.units.find((u) => u.startMin === 1020)!.status, "PENDING");
      await assert.rejects(
        () => service.createHold({ locationId: LOCATION_ID, date, startMin: 1020, endMin: 1080 }),
        /just taken|another customer/i,
      );
    });

    it("refuses to confirm while money is outstanding", async () => {
      const booking = await pendingBooking();
      await acceptPayment(booking, 1400);
      await assert.rejects(() => service.confirmBooking(booking._id, ADMIN), /outstanding/i);
    });

    it("accepts a balance payment and then allows confirmation", async () => {
      const date = futureDate();
      const booking = await pendingBooking(date);
      await acceptPayment(booking, 1400);

      const withBalance = await service.addPaymentAttempt({
        bookingId: booking._id,
        screenshotKey: "payment-screenshots/test/balance.jpg",
      });
      assert.equal(withBalance.payments.length, 2, "the first screenshot must not be overwritten");

      const settled = await acceptPayment(withBalance, 200);
      assert.equal(settled.amountPaid, 1600);
      assert.equal(settled.paymentVerificationStatus, "VERIFIED");

      const confirmed = await service.confirmBooking(booking._id, ADMIN);
      assert.equal(confirmed.status, "CONFIRMED");
      const units = await collections.slotUnits(db).find({ bookingId: booking._id }).toArray();
      assert.ok(units.every((u) => u.status === "BOOKED"));
    });

    it("keeps the full payment history rather than overwriting it", async () => {
      const booking = await pendingBooking();
      await acceptPayment(booking, 1400);
      const withBalance = await service.addPaymentAttempt({ bookingId: booking._id, screenshotKey: "a/b.jpg" });
      const settled = await acceptPayment(withBalance, 200);

      assert.deepEqual(
        settled.payments.map((p) => [p.amount, p.status]),
        [
          [1400, "ACCEPTED"],
          [200, "ACCEPTED"],
        ],
      );
    });

    it("turning down a screenshot does NOT release the slots", async () => {
      const date = futureDate();
      const booking = await pendingBooking(date);

      const rejected = await service.reviewPayment({
        bookingId: booking._id,
        attemptId: booking.payments[0]!.id,
        accepted: false,
        note: "Screenshot is unclear",
        admin: ADMIN,
      });

      assert.equal(rejected.paymentVerificationStatus, "REJECTED");
      assert.equal(rejected.status, "PENDING", "the booking itself survives a bad screenshot");

      const availability = await service.getAvailability(LOCATION_ID, date);
      assert.equal(
        availability.units.find((u) => u.startMin === 1020)!.status,
        "PENDING",
        "the slots must stay with this customer",
      );

      // And the customer can still put it right.
      const retried = await service.addPaymentAttempt({ bookingId: booking._id, screenshotKey: "a/clear.jpg" });
      assert.equal(
        retried.paymentVerificationStatus,
        "PENDING",
        "a fresh screenshot puts the booking back in the review queue, not the rejected pile",
      );
      const settled = await acceptPayment(retried, 1600);
      assert.equal(settled.paymentVerificationStatus, "VERIFIED");
    });

    it("keeps a part-paid booking marked PARTIAL when the balance screenshot arrives", async () => {
      const booking = await pendingBooking();
      await acceptPayment(booking, 1400);

      const withBalance = await service.addPaymentAttempt({ bookingId: booking._id, screenshotKey: "a/balance.jpg" });
      assert.equal(
        withBalance.paymentVerificationStatus,
        "PARTIAL",
        "money that already arrived must not be downgraded to unreviewed",
      );
      assert.equal(withBalance.amountPaid, 1400);
    });

    /**
     * The turn-it-down-then-they-pay case. Customers send the replacement on
     * WhatsApp as often as through the site, and before this the booking could
     * only ever be rejected — the admin had no way to bank money they had
     * genuinely received.
     */
    it("lets an admin record a payment after every screenshot was turned down", async () => {
      const date = futureDate();
      const booking = await pendingBooking(date); // 5-7 PM costs 1600

      const turnedDown = await service.reviewPayment({
        bookingId: booking._id,
        attemptId: booking.payments[0]!.id,
        accepted: false,
        note: "Screenshot is unclear",
        admin: ADMIN,
      });
      assert.equal(turnedDown.paymentVerificationStatus, "REJECTED");

      const recorded = await service.recordManualPayment({
        bookingId: booking._id,
        amount: 1600,
        note: "Sent on WhatsApp",
        admin: ADMIN,
      });

      assert.equal(recorded.paymentVerificationStatus, "VERIFIED");
      assert.equal(recorded.amountPaid, 1600);
      assert.equal(recorded.payments.length, 2, "the rejected screenshot stays on the record");
      assert.equal(recorded.payments[1]!.screenshotKey, null, "there is no image behind a staff-recorded payment");
      assert.equal(recorded.payments[1]!.reviewedBy, ADMIN.username, "who recorded it is kept");
      assert.equal(recorded.payments[1]!.note, "Sent on WhatsApp");

      const confirmed = await service.confirmBooking(booking._id, ADMIN);
      assert.equal(confirmed.status, "CONFIRMED");
      const units = await collections.slotUnits(db).find({ bookingId: booking._id }).toArray();
      assert.ok(units.every((u) => u.status === "BOOKED"));
    });

    it("counts a recorded payment towards a balance like any other", async () => {
      const booking = await pendingBooking();
      await acceptPayment(booking, 1400);

      const settled = await service.recordManualPayment({
        bookingId: booking._id,
        amount: 200,
        note: "Paid in cash at the ground",
        admin: ADMIN,
      });
      assert.equal(settled.amountPaid, 1600);
      assert.equal(settled.paymentVerificationStatus, "VERIFIED");
    });

    it("refuses a recorded payment that is not a real amount", async () => {
      const booking = await pendingBooking();
      for (const amount of [0, -100, Number.NaN]) {
        await assert.rejects(
          () => service.recordManualPayment({ bookingId: booking._id, amount, note: "Cash", admin: ADMIN }),
          /amount you received/i,
        );
      }
    });

    it("will not record a payment against a booking that is no longer pending", async () => {
      const booking = await pendingBooking();
      await service.rejectBooking(booking._id, "Customer cancelled", ADMIN);
      await assert.rejects(
        () => service.recordManualPayment({ bookingId: booking._id, amount: 1600, note: "Cash", admin: ADMIN }),
        /not waiting for a payment/i,
      );
    });

    it("only an explicit rejection releases the slots", async () => {
      const date = futureDate();
      const booking = await pendingBooking(date);
      await acceptPayment(booking, 1400);

      const released = await service.rejectBooking(booking._id, "Customer cancelled", ADMIN);
      assert.equal(released.status, "REJECTED");
      assert.equal(released.amountPaid, 1400, "the payment record survives for the refund conversation");

      const availability = await service.getAvailability(LOCATION_ID, date);
      assert.equal(availability.units.find((u) => u.startMin === 1020)!.status, "AVAILABLE");
    });

    it("cannot review the same screenshot twice", async () => {
      const booking = await pendingBooking();
      const attempt = booking.payments[0]!;
      await service.reviewPayment({
        bookingId: booking._id,
        attemptId: attempt.id,
        accepted: true,
        amount: 800,
        admin: ADMIN,
      });

      await assert.rejects(
        () =>
          service.reviewPayment({
            bookingId: booking._id,
            attemptId: attempt.id,
            accepted: true,
            amount: 800,
            admin: ADMIN,
          }),
        /already been reviewed/i,
      );

      const stored = await collections.bookings(db).findOne({ _id: booking._id });
      assert.equal(stored!.amountPaid, 800, "a double click must not double-count the money");
    });

    it("lets two admins review two screenshots at once without losing either", async () => {
      const booking = await pendingBooking();
      const second = await service.addPaymentAttempt({ bookingId: booking._id, screenshotKey: "a/second.jpg" });
      const [first, other] = second.payments;

      await Promise.all([
        service.reviewPayment({ bookingId: booking._id, attemptId: first!.id, accepted: true, amount: 1000, admin: ADMIN }),
        service.reviewPayment({
          bookingId: booking._id,
          attemptId: other!.id,
          accepted: true,
          amount: 600,
          admin: { username: "other" },
        }),
      ]);

      const stored = await collections.bookings(db).findOne({ _id: booking._id });
      assert.equal(stored!.amountPaid, 1600, "concurrent reviews must both count");
      assert.equal(stored!.paymentVerificationStatus, "VERIFIED");
    });

    it("refuses an accepted payment with no amount", async () => {
      const booking = await pendingBooking();
      await assert.rejects(
        () =>
          service.reviewPayment({
            bookingId: booking._id,
            attemptId: booking.payments[0]!.id,
            accepted: true,
            amount: 0,
            admin: ADMIN,
          }),
        /amount shown/i,
      );
    });

    it("refuses more screenshots once the booking is settled", async () => {
      const booking = await pendingBooking();
      await acceptPayment(booking);
      await service.confirmBooking(booking._id, ADMIN);

      await assert.rejects(
        () => service.addPaymentAttempt({ bookingId: booking._id, screenshotKey: "a/late.jpg" }),
        /not waiting for a payment/i,
      );
    });
  });

  /* ── Housekeeping ──────────────────────────────────────────────────── */

  describe("housekeeping", () => {
    it("cleans up expired holds without affecting correctness either way", async () => {
      const date = futureDate();
      await service.createHold({ locationId: LOCATION_ID, date, startMin: 1020, endMin: 1140 });
      await collections.slotUnits(db).updateMany({ date }, { $set: { holdUntil: new Date(Date.now() - 1000) } });

      const cleaned = await service.cleanupExpiredHolds();
      assert.equal(cleaned, 2);

      const units = await collections.slotUnits(db).find({ date }).toArray();
      assert.ok(units.every((u) => u.status === "AVAILABLE" && u.holdTokenHash === null));
    });

    it("leaves booked and blocked units alone during cleanup", async () => {
      const date = futureDate();
      await service.blockSlots({ locationId: LOCATION_ID, date, startMin: 1020, endMin: 1080, reason: "Nets", force: false, admin: ADMIN });
      await service.cleanupExpiredHolds();
      const unit = await collections.slotUnits(db).findOne({ date, startMin: 1020 });
      assert.equal(unit!.status, "BLOCKED");
    });
  });

  /* ── Database consistency after everything above ───────────────────── */

  describe("database consistency", () => {
    it("holds no duplicate unit identity, orphan hold or booking without slots", async () => {
      const date = futureDate();
      // Build a realistic mixture of state.
      const holdA = await service.createHold({ locationId: LOCATION_ID, date, startMin: 1020, endMin: 1140 });
      const bookingA = await service.submitBooking({
        holdToken: holdA.holdToken,
        customerName: "Ravi Kumar",
        customerPhone: "9876543210",
        paymentScreenshotKey: SCREENSHOT,
      });
      await acceptPayment(bookingA);
      await service.confirmBooking(bookingA._id, ADMIN);

      const holdB = await service.createHold({ locationId: LOCATION_ID, date, startMin: 1140, endMin: 1200 });
      const bookingB = await service.submitBooking({
        holdToken: holdB.holdToken,
        customerName: "Sita R",
        customerPhone: "9876543211",
        paymentScreenshotKey: SCREENSHOT,
      });
      await service.rejectBooking(bookingB._id, "Payment not received", ADMIN);

      await service.createHold({ locationId: LOCATION_ID, date, startMin: 1200, endMin: 1260 });

      const units = await collections.slotUnits(db).find({ locationId: LOCATION_ID, date }).toArray();
      const bookings = await collections.bookings(db).find({}).toArray();

      // No duplicate unit identities.
      const identities = units.map((u) => `${u.locationId}|${u.date}|${u.startMin}`);
      assert.equal(new Set(identities).size, identities.length, "unique index must prevent duplicate units");

      // No duplicate booking references.
      const references = bookings.map((b) => b.reference);
      assert.equal(new Set(references).size, references.length);

      // Every confirmed booking still owns exactly its units.
      for (const booking of bookings.filter((b) => b.status === "CONFIRMED")) {
        const owned = units.filter((u) => u.bookingId?.equals(booking._id));
        assert.equal(owned.length, booking.unitStarts.length, "a confirmed booking must own all its slots");
        assert.ok(owned.every((u) => u.status === "BOOKED"));
      }

      // Rejected bookings own nothing.
      for (const booking of bookings.filter((b) => b.status === "REJECTED")) {
        assert.equal(units.filter((u) => u.bookingId?.equals(booking._id)).length, 0);
      }

      // No unit points at a booking that does not exist.
      const bookingIds = new Set(bookings.map((b) => b._id.toHexString()));
      for (const unit of units.filter((u) => u.bookingId)) {
        assert.ok(bookingIds.has(unit.bookingId!.toHexString()), "no orphan slot ownership");
      }

      // No PENDING/BOOKED unit lacks a booking.
      for (const unit of units.filter((u) => u.status === "PENDING" || u.status === "BOOKED")) {
        assert.ok(unit.bookingId, "a taken slot must always name its booking");
      }
    });
  });
});
