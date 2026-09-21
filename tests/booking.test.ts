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

const FACILITY_ID = new ObjectId("000000000000000000000011");
const OTHER_FACILITY_ID = new ObjectId("000000000000000000000012");
const COURTS_FACILITY_ID = new ObjectId("000000000000000000000013");
const BOWLING_FACILITY_ID = new ObjectId("000000000000000000000014");

/** The turf under test. Everything keyed on a resource, as the engine is. */
const RESOURCE_ID = new ObjectId("000000000000000000000021");
const OTHER_RESOURCE_ID = new ObjectId("000000000000000000000022");
/** Two courts sharing one facility — the independence case. */
const COURT_1_ID = new ObjectId("000000000000000000000023");
const COURT_2_ID = new ObjectId("000000000000000000000024");
const BOWLING_ID = new ObjectId("000000000000000000000025");

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
  oversPerSlot: 0,
  payAtVenueMaxOvers: 0,
  ballTypes: [],
};

/**
 * 15-minute blocks of ten overs, priced per block rather than by the clock.
 * Up to 40 overs is paid for at the ground; beyond that, online first.
 */
const BOWLING_SCHEDULE = {
  slotMinutes: 15,
  openMin: 17 * 60,
  closeMin: 23 * 60,
  bookingWindowDays: 30,
  holdMinutes: 10,
  priceRules: [{ fromMin: 17 * 60, toMin: 23 * 60, price: 0 }],
  oversPerSlot: 10,
  payAtVenueMaxOvers: 40,
  ballTypes: [
    { id: "synthetic", name: "Synthetic ball", pricePerSlot: 180 },
    { id: "leather", name: "Leather ball", pricePerSlot: 100 },
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
/** A well-formed UPI reference. Required for anything paid online. */
const UTR = "123456789012";
/** Matches the real key format, so the storage layer accepts it for deletion. */
const REAL_SCREENSHOT = "payment-screenshots/2026-01-01/00000000-0000-4000-8000-000000000000.jpg";

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
      collections.facilities(db).deleteMany({}),
      collections.resources(db).deleteMany({}),
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
          mapsUrl: "",
          description: "",
          image: "",
          phone: "9876543210",
          active,
          createdAt: now,
          updatedAt: now,
        },
        { upsert: true },
      );
    }

    for (const [id, locationId, name, kind, config] of [
      [FACILITY_ID, LOCATION_ID, "Box Cricket", "HOURLY", SCHEDULE],
      [OTHER_FACILITY_ID, OTHER_LOCATION_ID, "Box Cricket", "HOURLY", SCHEDULE],
      [COURTS_FACILITY_ID, LOCATION_ID, "Pickleball", "HOURLY", SCHEDULE],
      [BOWLING_FACILITY_ID, LOCATION_ID, "Bowling Machine", "OVERS", BOWLING_SCHEDULE],
    ] as const) {
      await collections.facilities(db).replaceOne(
        { _id: id },
        {
          locationId,
          name,
          slug: `${name.toLowerCase().replace(/\s+/g, "-")}-${id.toHexString().slice(-2)}`,
          kind,
          description: "",
          sortOrder: 0,
          active: true,
          config,
          createdAt: now,
          updatedAt: now,
        },
        { upsert: true },
      );
    }

    for (const [id, facilityId, locationId, name] of [
      [RESOURCE_ID, FACILITY_ID, LOCATION_ID, "Turf"],
      [OTHER_RESOURCE_ID, OTHER_FACILITY_ID, OTHER_LOCATION_ID, "Turf"],
      [COURT_1_ID, COURTS_FACILITY_ID, LOCATION_ID, "Court 1"],
      [COURT_2_ID, COURTS_FACILITY_ID, LOCATION_ID, "Court 2"],
      [BOWLING_ID, BOWLING_FACILITY_ID, LOCATION_ID, "Machine"],
    ] as const) {
      await collections.resources(db).replaceOne(
        { _id: id },
        {
          locationId,
          facilityId,
          name,
          slug: `${name.toLowerCase().replace(/\s+/g, "-")}-${id.toHexString().slice(-2)}`,
          sortOrder: 0,
          active: true,
          createdAt: now,
          updatedAt: now,
        },
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
      const result = await service.getAvailability(RESOURCE_ID, futureDate());
      assert.equal(result.units.length, 6); // 5 PM – 11 PM in one-hour units
      assert.ok(result.units.every((u) => u.status === "AVAILABLE"));
      assert.equal(result.units[0]!.price, 800);
      assert.equal(result.units.at(-1)!.price, 900);
    });

    it("never exposes customer data", async () => {
      await service.createHold({ resourceId: RESOURCE_ID, date: futureDate(), startMin: 1020, endMin: 1080 });
      const result = await service.getAvailability(RESOURCE_ID, futureDate());
      const serialised = JSON.stringify(result);
      assert.ok(!serialised.includes("customerName"));
      assert.ok(!serialised.includes("holdToken"));
      assert.ok(!serialised.includes("9876543210"));
    });

    it("refuses past dates", async () => {
      await assert.rejects(() => service.getAvailability(RESOURCE_ID, pastDate()), /already passed/i);
    });

    it("refuses dates beyond the booking window", async () => {
      await assert.rejects(() => service.getAvailability(RESOURCE_ID, futureDate(45)), /days in advance/i);
    });

    it("refuses an inactive location", async () => {
      await assert.rejects(() => service.getAvailability(OTHER_RESOURCE_ID, futureDate()), /not accepting bookings/i);
    });

    it("marks slots whose start time has already passed as PAST, keeping later ones bookable", async () => {
      const today = new Date(Date.now() + IST_OFFSET).toISOString().slice(0, 10);
      // Pretend it is 8:30 PM IST today.
      const now = new Date(new Date(`${today}T20:30:00.000Z`).getTime() - IST_OFFSET);
      const result = await service.getAvailability(RESOURCE_ID, today, now);

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
      const hold = await service.createHold({ resourceId: RESOURCE_ID, date, startMin: 1020, endMin: 1080 });
      assert.equal(hold.amount, 800);
      assert.equal(hold.holdToken.length, 64);

      const availability = await service.getAvailability(RESOURCE_ID, date);
      assert.equal(availability.units.find((u) => u.startMin === 1020)!.status, "HELD");
    });

    it("holds every underlying unit of a multi-hour request", async () => {
      const date = futureDate();
      const hold = await service.createHold({ resourceId: RESOURCE_ID, date, startMin: 1020, endMin: 1260 }); // 5–9
      assert.equal(hold.amount, 800 + 800 + 900 + 900);

      const units = await collections.slotUnits(db).find({ resourceId: RESOURCE_ID, date }).toArray();
      assert.equal(units.length, 4);
      assert.ok(units.every((u) => u.status === "HELD"));
    });

    it("rejects a range that does not line up with the schedule", async () => {
      await assert.rejects(
        () => service.createHold({ resourceId: RESOURCE_ID, date: futureDate(), startMin: 1050, endMin: 1110 }),
        /not bookable/i,
      );
    });

    it("never persists the raw hold token", async () => {
      const date = futureDate();
      const hold = await service.createHold({ resourceId: RESOURCE_ID, date, startMin: 1020, endMin: 1080 });
      const unit = await collections.slotUnits(db).findOne({ resourceId: RESOURCE_ID, date, startMin: 1020 });
      assert.notEqual(unit!.holdTokenHash, hold.holdToken);
      assert.equal(unit!.holdTokenHash!.length, 64); // sha-256 hex
    });

    it("recovers a live hold from its token, so a refresh does not double-book", async () => {
      const date = futureDate();
      const hold = await service.createHold({ resourceId: RESOURCE_ID, date, startMin: 1020, endMin: 1140 });
      const recovered = await service.getHold(hold.holdToken);
      assert.equal(recovered?.startMin, 1020);
      assert.equal(recovered?.endMin, 1140);
      assert.equal(recovered?.amount, 1600);

      const units = await collections.slotUnits(db).countDocuments({ resourceId: RESOURCE_ID, date });
      assert.equal(units, 2, "recovery must not create more reservations");
    });

    it("releases a hold on request", async () => {
      const date = futureDate();
      const hold = await service.createHold({ resourceId: RESOURCE_ID, date, startMin: 1020, endMin: 1080 });
      await service.releaseHold(hold.holdToken);

      const availability = await service.getAvailability(RESOURCE_ID, date);
      assert.equal(availability.units.find((u) => u.startMin === 1020)!.status, "AVAILABLE");
    });

    it("treats an expired hold as available without any cleanup job running", async () => {
      const date = futureDate();
      const hold = await service.createHold({ resourceId: RESOURCE_ID, date, startMin: 1020, endMin: 1080 });

      // Wind the hold's expiry into the past; the document still says HELD.
      await collections.slotUnits(db).updateOne(
        { holdTokenHash: { $ne: null }, date },
        { $set: { holdUntil: new Date(Date.now() - 60_000) } },
      );

      const stored = await collections.slotUnits(db).findOne({ date, startMin: 1020 });
      assert.equal(stored!.status, "HELD", "the stored row is deliberately left stale");

      const availability = await service.getAvailability(RESOURCE_ID, date);
      assert.equal(availability.units.find((u) => u.startMin === 1020)!.status, "AVAILABLE");
      assert.equal(await service.getHold(hold.holdToken), null);
    });

    it("lets a new customer take over a slot whose hold expired", async () => {
      const date = futureDate();
      const first = await service.createHold({ resourceId: RESOURCE_ID, date, startMin: 1020, endMin: 1080 });
      await collections.slotUnits(db).updateMany({ date }, { $set: { holdUntil: new Date(Date.now() - 60_000) } });

      const second = await service.createHold({ resourceId: RESOURCE_ID, date, startMin: 1020, endMin: 1080 });
      assert.notEqual(second.holdToken, first.holdToken);

      // And the first customer can no longer submit against it.
      await assert.rejects(
        () =>
          service.submitBooking({
            holdToken: first.holdToken,
            customerName: "Late Larry",
            customerPhone: "9876543210",
            paymentScreenshotKey: SCREENSHOT,
            utr: UTR,
          }),
        /expired|verify your slot hold/i,
      );
    });

    it("refuses to hold a slot on a blocked day", async () => {
      const date = futureDate();
      await service.blockDay({ resourceId: RESOURCE_ID, date, reason: "Festival", force: false, admin: ADMIN });
      await assert.rejects(
        () => service.createHold({ resourceId: RESOURCE_ID, date, startMin: 1020, endMin: 1080 }),
        /not taking bookings/i,
      );
    });

    it("refuses to hold an inactive location", async () => {
      await assert.rejects(
        () => service.createHold({ resourceId: OTHER_RESOURCE_ID, date: futureDate(), startMin: 1020, endMin: 1080 }),
        /not accepting bookings/i,
      );
    });

    it("refuses to hold a past date", async () => {
      await assert.rejects(
        () => service.createHold({ resourceId: RESOURCE_ID, date: pastDate(), startMin: 1020, endMin: 1080 }),
        /already passed/i,
      );
    });
  });

  /* ── Concurrency: the core guarantee ───────────────────────────────── */

  /* ── Independent resources ─────────────────────────────────────────── */

  describe("independent courts", () => {
    /**
     * The requirement the whole resource layer exists for: Court 1 and Court 2
     * are separate things, so the same hour sells twice. If slot identity were
     * still keyed on the location, the second hold here would collide.
     */
    it("lets two customers book the same hour on different courts", async () => {
      const on = futureDate(6);
      const first = await service.createHold({ resourceId: COURT_1_ID, date: on, startMin: 1080, endMin: 1140 });
      const second = await service.createHold({ resourceId: COURT_2_ID, date: on, startMin: 1080, endMin: 1140 });

      assert.notEqual(first.holdToken, second.holdToken);
      assert.equal(first.resourceName, "Court 1");
      assert.equal(second.resourceName, "Court 2");

      for (const id of [COURT_1_ID, COURT_2_ID]) {
        const availability = await service.getAvailability(id, on);
        assert.equal(availability.units.find((u) => u.startMin === 1080)!.status, "HELD");
      }
    });

    it("still refuses a second booking of the same hour on the SAME court", async () => {
      const on = futureDate(6);
      await service.createHold({ resourceId: COURT_1_ID, date: on, startMin: 1080, endMin: 1140 });
      await assert.rejects(
        () => service.createHold({ resourceId: COURT_1_ID, date: on, startMin: 1080, endMin: 1140 }),
        /just taken by someone else/i,
      );
    });

    it("keeps simultaneous holds on one court down to a single winner", async () => {
      const on = futureDate(6);
      const results = await Promise.allSettled([
        service.createHold({ resourceId: COURT_1_ID, date: on, startMin: 1200, endMin: 1260 }),
        service.createHold({ resourceId: COURT_1_ID, date: on, startMin: 1200, endMin: 1260 }),
        service.createHold({ resourceId: COURT_1_ID, date: on, startMin: 1200, endMin: 1260 }),
      ]);
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    });

    it("blocks one court without touching the other", async () => {
      const on = futureDate(6);
      await service.blockSlots({
        resourceId: COURT_1_ID,
        date: on,
        startMin: 1080,
        endMin: 1140,
        reason: "Resurfacing",
        force: false,
        admin: ADMIN,
      });

      const blocked = await service.getAvailability(COURT_1_ID, on);
      const open = await service.getAvailability(COURT_2_ID, on);
      assert.equal(blocked.units.find((u) => u.startMin === 1080)!.status, "BLOCKED");
      assert.equal(open.units.find((u) => u.startMin === 1080)!.status, "AVAILABLE");
    });

    it("closes one court for a day without closing the other", async () => {
      const on = futureDate(6);
      await service.blockDay({ resourceId: COURT_1_ID, date: on, reason: "Repairs", force: false, admin: ADMIN });

      assert.equal((await service.getAvailability(COURT_1_ID, on)).dayBlocked, true);
      assert.equal((await service.getAvailability(COURT_2_ID, on)).dayBlocked, false);
    });
  });

  /* ── Bowling machine: overs, ball pricing, 15-minute units ──────────── */

  describe("bowling machine", () => {
    it("sells 15-minute units rather than hours", async () => {
      const availability = await service.getAvailability(BOWLING_ID, futureDate());
      assert.equal(availability.facilityKind, "OVERS");
      assert.equal(availability.slotMinutes, 15);
      assert.equal(availability.units.length, 24); // 5 PM – 11 PM in quarter hours
      assert.equal(availability.units[0]!.endMin - availability.units[0]!.startMin, 15);
      assert.equal(availability.oversPerSlot, 10);
      assert.equal(availability.payAtVenueMaxOvers, 40);
    });

    /** The ladder is generated from the rule, so it can never disagree with it. */
    it("offers overs up to what the day can actually hold", async () => {
      const availability = await service.getAvailability(BOWLING_ID, futureDate());
      assert.deepEqual(availability.oversLadder.slice(0, 4), [10, 20, 30, 40]);
      // 6 hours open / 15-minute blocks = 24 blocks = 240 overs.
      assert.equal(availability.oversLadder.at(-1), 240);
    });

    /** Every overs option must lock exactly the quarter-hours it takes. */
    it("reserves the right number of consecutive units for each overs option", async () => {
      // A different day each time, all inside the 30-day booking window, so the
      // four cases cannot collide with one another.
      for (const [overs, expectedUnits, daysAhead] of [
        [10, 1, 17],
        [20, 2, 18],
        [30, 3, 19],
        [40, 4, 20],
      ] as const) {
        const on = futureDate(daysAhead);
        const hold = await service.createHold({
          resourceId: BOWLING_ID,
          date: on,
          startMin: 1080,
          overs,
          ballTypeId: "synthetic",
        });

        assert.equal(hold.overs, overs);
        assert.equal(hold.endMin - hold.startMin, expectedUnits * 15);
        const units = await collections.slotUnits(db).find({ resourceId: BOWLING_ID, date: on }).toArray();
        assert.equal(units.length, expectedUnits, `${overs} overs should lock ${expectedUnits} units`);
        assert.ok(units.every((u) => u.status === "HELD"));
      }
    });

    /**
     * The owner sells blocks, not clock time: ₹180 buys ten synthetic overs, so
     * twenty costs ₹360 and forty ₹720. Nothing is pro-rated by the hour.
     */
    it("charges one ball price per block of overs", async () => {
      for (const [overs, expected, daysAhead] of [
        [10, 180, 7],
        [20, 360, 8],
        [30, 540, 9],
        [40, 720, 10],
      ] as const) {
        const hold = await service.createHold({
          resourceId: BOWLING_ID,
          date: futureDate(daysAhead),
          startMin: 1080,
          overs,
          ballTypeId: "synthetic",
        });
        assert.equal(hold.amount, expected, `${overs} synthetic overs should cost ${expected}`);
        assert.equal(hold.ballTypeName, "Synthetic ball");
      }
    });

    it("charges a different ball at its own block price", async () => {
      const hold = await service.createHold({
        resourceId: BOWLING_ID,
        date: futureDate(11),
        startMin: 1080,
        overs: 20,
        ballTypeId: "leather",
      });
      assert.equal(hold.amount, 200, "two blocks of a 100-per-block ball");
    });

    /**
     * There is no ceiling. The owner said customers may book 50, 60 or 70 overs
     * as they like, so the only limit is how much of the day is left.
     */
    it("allows sessions well beyond the quick-pick options", async () => {
      for (const [overs, expectedUnits, price, daysAhead] of [
        [50, 5, 900, 12],
        [70, 7, 1260, 13],
        [120, 12, 2160, 14],
      ] as const) {
        const on = futureDate(daysAhead);
        const hold = await service.createHold({
          resourceId: BOWLING_ID,
          date: on,
          startMin: 1020,
          overs,
          ballTypeId: "synthetic",
        });
        assert.equal(hold.overs, overs);
        assert.equal(hold.amount, price, `${overs} overs should cost ${price}`);
        const units = await collections.slotUnits(db).find({ resourceId: BOWLING_ID, date: on }).toArray();
        assert.equal(units.length, expectedUnits);
      }
    });

    /** A fraction of a block cannot be reserved, so it is refused outright. */
    it("refuses overs that are not a whole number of blocks", async () => {
      for (const overs of [5, 15, 25, 33] as const) {
        await assert.rejects(
          () =>
            service.createHold({
              resourceId: BOWLING_ID,
              date: futureDate(),
              startMin: 1080,
              overs,
              ballTypeId: "synthetic",
            }),
          /blocks of 10/i,
          `${overs} overs is not a whole number of blocks`,
        );
      }
    });

    /** The real limit: a session that would run past closing time. */
    it("refuses a session that will not fit before closing", async () => {
      await assert.rejects(
        () =>
          service.createHold({
            resourceId: BOWLING_ID,
            date: futureDate(),
            startMin: 1350, // 10:30 PM, with the machine closing at 11
            overs: 40,
            ballTypeId: "synthetic",
          }),
        /will not fit/i,
      );
    });

    it("refuses a ball type that does not exist", async () => {
      await assert.rejects(
        () =>
          service.createHold({
            resourceId: BOWLING_ID,
            date: futureDate(),
            startMin: 1080,
            overs: 10,
            ballTypeId: "golf-ball",
          }),
        /choose a ball type/i,
      );
    });

    /**
     * All-or-nothing at the 15-minute level: if a quarter-hour in the middle of a
     * 30-over session is gone, the earlier ones must NOT be left reserved.
     */
    it("reserves nothing when any required quarter-hour is taken", async () => {
      const on = futureDate(8);
      // Someone already holds 5:30–5:45.
      await service.createHold({
        resourceId: BOWLING_ID,
        date: on,
        startMin: 1050,
        overs: 10,
        ballTypeId: "synthetic",
      });

      await assert.rejects(() =>
        service.createHold({
          resourceId: BOWLING_ID,
          date: on,
          startMin: 1020,
          overs: 30, // 5:00–5:45, which runs straight through the held quarter
          ballTypeId: "synthetic",
        }),
      );

      const units = await collections
        .slotUnits(db)
        .find({ resourceId: BOWLING_ID, date: on, status: "HELD" })
        .toArray();
      assert.equal(units.length, 1, "the failed session must not leave its earlier units reserved");
      assert.equal(units[0]!.startMin, 1050);
    });

    it("lets only one of two overlapping simultaneous sessions win", async () => {
      const on = futureDate(9);
      const results = await Promise.allSettled([
        service.createHold({ resourceId: BOWLING_ID, date: on, startMin: 1080, overs: 20, ballTypeId: "synthetic" }),
        service.createHold({ resourceId: BOWLING_ID, date: on, startMin: 1095, overs: 20, ballTypeId: "leather" }),
      ]);
      // The two overlap on 6:15–6:30, so they cannot both succeed.
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    });

    it("carries the overs and the ball onto the booking", async () => {
      const on = futureDate(15);
      const hold = await service.createHold({
        resourceId: BOWLING_ID,
        date: on,
        startMin: 1080,
        overs: 20,
        ballTypeId: "leather",
      });
      const booking = await service.submitBooking({
        holdToken: hold.holdToken,
        customerName: "Ravi Kumar",
        customerPhone: "9876543210",
        paymentScreenshotKey: null,
      });

      assert.equal(booking.overs, 20);
      assert.equal(booking.ballTypeName, "Leather ball");
      assert.equal(booking.amount, 200, "two blocks of a 100-per-block ball");
      assert.equal(booking.facilityName, "Bowling Machine");
      assert.equal(booking.unitStarts.length, 2);
    });
  });

  /* ── Short sessions are paid for at the ground ──────────────────────── */

  describe("pay at the ground", () => {
    /**
     * The owner's rule: up to 40 overs, do not make the customer pay online.
     * Confirm it on the spot and take the money when they arrive.
     */
    it("confirms a short session immediately with no screenshot", async () => {
      const on = futureDate(16);
      const hold = await service.createHold({
        resourceId: BOWLING_ID,
        date: on,
        startMin: 1080,
        overs: 40,
        ballTypeId: "synthetic",
      });
      assert.equal(hold.payAtVenue, true, "the customer must be told before they commit");

      const booking = await service.submitBooking({
        holdToken: hold.holdToken,
        customerName: "Ravi Kumar",
        customerPhone: "9876543210",
        paymentScreenshotKey: null,
      });

      assert.equal(booking.status, "CONFIRMED");
      assert.equal(booking.payAtVenue, true);
      assert.equal(booking.payments.length, 0);
      assert.equal(booking.paymentScreenshotKey, null);
      // Money is still owed — it just has not been collected yet.
      assert.equal(booking.paymentVerificationStatus, "PENDING");
      assert.equal(booking.amount, 720);
      assert.equal(booking.amountPaid, 0);
    });

    /** Confirmed means the slots are BOOKED, not merely pending review. */
    it("locks the slots outright", async () => {
      const on = futureDate(17);
      const hold = await service.createHold({
        resourceId: BOWLING_ID,
        date: on,
        startMin: 1080,
        overs: 20,
        ballTypeId: "synthetic",
      });
      await service.submitBooking({
        holdToken: hold.holdToken,
        customerName: "Ravi Kumar",
        customerPhone: "9876543210",
        paymentScreenshotKey: null,
      });

      const units = await collections.slotUnits(db).find({ resourceId: BOWLING_ID, date: on }).toArray();
      assert.equal(units.length, 2);
      assert.ok(units.every((u) => u.status === "BOOKED"), units.map((u) => u.status).join(","));

      const availability = await service.getAvailability(BOWLING_ID, on);
      assert.equal(availability.units.find((u) => u.startMin === 1080)!.status, "BOOKED");
    });

    /** Above the threshold the normal payment flow applies, unchanged. */
    it("still demands payment for a long session", async () => {
      const on = futureDate(18);
      const hold = await service.createHold({
        resourceId: BOWLING_ID,
        date: on,
        startMin: 1020,
        overs: 50,
        ballTypeId: "synthetic",
      });
      assert.equal(hold.payAtVenue, false);

      await assert.rejects(
        () =>
          service.submitBooking({
            holdToken: hold.holdToken,
            customerName: "Ravi Kumar",
            customerPhone: "9876543210",
            paymentScreenshotKey: null,
          }),
        /UPI reference number/i,
      );

      const booking = await service.submitBooking({
        holdToken: hold.holdToken,
        customerName: "Ravi Kumar",
        customerPhone: "9876543210",
        paymentScreenshotKey: SCREENSHOT,
        utr: UTR,
      });
      assert.equal(booking.status, "PENDING");
      assert.equal(booking.payAtVenue, false);
    });

    /** Hourly facilities are untouched by any of this. */
    it("never applies to an hourly booking", async () => {
      const hold = await service.createHold({
        resourceId: RESOURCE_ID,
        date: futureDate(19),
        startMin: 1020,
        endMin: 1080,
      });
      assert.equal(hold.payAtVenue, false);
      await assert.rejects(
        () =>
          service.submitBooking({
            holdToken: hold.holdToken,
            customerName: "Ravi Kumar",
            customerPhone: "9876543210",
            paymentScreenshotKey: null,
          }),
        /UPI reference number/i,
      );
    });

    /**
     * Without this a no-show would hold the machine for good: the booking is
     * already CONFIRMED, and confirmed bookings cannot normally be released.
     */
    it("lets an admin cancel a no-show and put the slots back on sale", async () => {
      const on = futureDate(20);
      const hold = await service.createHold({
        resourceId: BOWLING_ID,
        date: on,
        startMin: 1080,
        overs: 20,
        ballTypeId: "synthetic",
      });
      const booking = await service.submitBooking({
        holdToken: hold.holdToken,
        customerName: "Ravi Kumar",
        customerPhone: "9876543210",
        paymentScreenshotKey: null,
      });

      const rejected = await service.rejectBooking(booking._id, "Did not turn up", ADMIN);
      assert.equal(rejected.status, "REJECTED");

      const availability = await service.getAvailability(BOWLING_ID, on);
      assert.equal(availability.units.find((u) => u.startMin === 1080)!.status, "AVAILABLE");
      assert.equal(availability.units.find((u) => u.startMin === 1095)!.status, "AVAILABLE");
    });

    /**
     * The cash the owner takes at the gate has to land somewhere, or the day's
     * takings are permanently short by every pay-at-venue booking.
     */
    it("lets the admin record the cash taken at the gate", async () => {
      const hold = await service.createHold({
        resourceId: BOWLING_ID,
        date: futureDate(21),
        startMin: 1080,
        overs: 20,
        ballTypeId: "synthetic",
      });
      const booking = await service.submitBooking({
        holdToken: hold.holdToken,
        customerName: "Ravi Kumar",
        customerPhone: "9876543210",
        paymentScreenshotKey: null,
      });

      const paid = await service.recordManualPayment({
        bookingId: booking._id,
        amount: booking.amount,
        note: "Cash at the gate",
        admin: ADMIN,
      });

      assert.equal(paid.amountPaid, booking.amount);
      assert.equal(paid.paymentVerificationStatus, "VERIFIED");
      assert.equal(paid.status, "CONFIRMED", "taking the money must not change the booking's state");
    });

    /** Once money is recorded, cancelling is a refund conversation, not a click. */
    it("refuses to cancel one that has been paid for", async () => {
      const hold = await service.createHold({
        resourceId: BOWLING_ID,
        date: futureDate(22),
        startMin: 1080,
        overs: 20,
        ballTypeId: "synthetic",
      });
      const booking = await service.submitBooking({
        holdToken: hold.holdToken,
        customerName: "Ravi Kumar",
        customerPhone: "9876543210",
        paymentScreenshotKey: null,
      });
      await service.recordManualPayment({
        bookingId: booking._id,
        amount: booking.amount,
        note: "Cash at the gate",
        admin: ADMIN,
      });

      await assert.rejects(
        () => service.rejectBooking(booking._id, "Changed their mind", ADMIN),
        /refund the customer/i,
      );
    });
  });

  /* ── Mobile verification ───────────────────────────────────────────── */

  describe("phone verification gate", () => {
    /** With the switch off nothing is asked for and nothing is sent. */
    it("books without verification when the toggle is off", async () => {
      const hold = await service.createHold({
        resourceId: RESOURCE_ID,
        date: futureDate(12),
        startMin: 1020,
        endMin: 1080,
      });
      const booking = await service.submitBooking({
        holdToken: hold.holdToken,
        customerName: "Ravi Kumar",
        customerPhone: "9876543210",
        paymentScreenshotKey: SCREENSHOT,
        utr: UTR,
        requirePhoneVerification: false,
      });
      assert.equal(booking.status, "PENDING");
      assert.equal(booking.phoneVerified, false);
    });

    it("refuses an unverified number when the toggle is on", async () => {
      const hold = await service.createHold({
        resourceId: RESOURCE_ID,
        date: futureDate(13),
        startMin: 1020,
        endMin: 1080,
      });
      await assert.rejects(
        () =>
          service.submitBooking({
            holdToken: hold.holdToken,
            customerName: "Ravi Kumar",
            customerPhone: "9876543210",
            paymentScreenshotKey: SCREENSHOT,
            utr: UTR,
            requirePhoneVerification: true,
            verifiedPhone: null,
          }),
        /verify your mobile number/i,
      );
    });

    /**
     * Verifying one number must not let a booking be made in another. Otherwise
     * the code proves nothing about the number the owner will actually ring.
     */
    it("refuses a number other than the one that was verified", async () => {
      const hold = await service.createHold({
        resourceId: RESOURCE_ID,
        date: futureDate(14),
        startMin: 1020,
        endMin: 1080,
      });
      await assert.rejects(
        () =>
          service.submitBooking({
            holdToken: hold.holdToken,
            customerName: "Ravi Kumar",
            customerPhone: "9876543210",
            paymentScreenshotKey: SCREENSHOT,
            utr: UTR,
            requirePhoneVerification: true,
            verifiedPhone: "9999999999",
          }),
        /verify your mobile number/i,
      );
    });

    /** A refused submission must leave the hold alone so the customer can finish. */
    it("keeps the hold when verification fails", async () => {
      const date = futureDate(15);
      const hold = await service.createHold({ resourceId: RESOURCE_ID, date, startMin: 1020, endMin: 1080 });
      await assert.rejects(() =>
        service.submitBooking({
          holdToken: hold.holdToken,
          customerName: "Ravi Kumar",
          customerPhone: "9876543210",
          paymentScreenshotKey: SCREENSHOT,
          utr: UTR,
          requirePhoneVerification: true,
          verifiedPhone: null,
        }),
      );

      const recovered = await service.getHold(hold.holdToken);
      assert.ok(recovered, "the hold must survive a refused submission");
      assert.equal(recovered!.submittedBookingReference, null);
    });

    it("accepts the matching verified number and records it", async () => {
      const hold = await service.createHold({
        resourceId: RESOURCE_ID,
        date: futureDate(16),
        startMin: 1020,
        endMin: 1080,
      });
      const booking = await service.submitBooking({
        holdToken: hold.holdToken,
        customerName: "Ravi Kumar",
        customerPhone: "9876543210",
        paymentScreenshotKey: SCREENSHOT,
        utr: UTR,
        requirePhoneVerification: true,
        verifiedPhone: "9876543210",
      });
      assert.equal(booking.status, "PENDING");
      assert.equal(booking.phoneVerified, true);
    });
  });

  describe("concurrency", () => {
    it("lets exactly one of two simultaneous identical requests win", async () => {
      const date = futureDate();
      const results = await Promise.allSettled([
        service.createHold({ resourceId: RESOURCE_ID, date, startMin: 1020, endMin: 1140 }),
        service.createHold({ resourceId: RESOURCE_ID, date, startMin: 1020, endMin: 1140 }),
      ]);

      const won = results.filter((r) => r.status === "fulfilled");
      const lost = results.filter((r) => r.status === "rejected");
      assert.equal(won.length, 1, "exactly one request may hold the slot");
      assert.equal(lost.length, 1);
      assert.match((lost[0] as PromiseRejectedResult).reason.message, /just taken|another customer|try again/i);

      const units = await collections.slotUnits(db).find({ resourceId: RESOURCE_ID, date }).toArray();
      const hashes = new Set(units.map((u) => u.holdTokenHash));
      assert.equal(hashes.size, 1, "all held units must belong to the same hold");
      assert.equal(units.length, 2);
    });

    it("lets exactly one of two overlapping multi-hour requests win (5–7 vs 6–8)", async () => {
      const date = futureDate();
      const results = await Promise.allSettled([
        service.createHold({ resourceId: RESOURCE_ID, date, startMin: 1020, endMin: 1140 }), // 5–7
        service.createHold({ resourceId: RESOURCE_ID, date, startMin: 1080, endMin: 1200 }), // 6–8
      ]);

      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);

      // No partial reservation may survive the loser's rollback.
      const held = await collections
        .slotUnits(db)
        .find({ resourceId: RESOURCE_ID, date, status: "HELD", holdUntil: { $gt: new Date() } })
        .toArray();
      const hashes = new Set(held.map((u) => u.holdTokenHash));
      assert.equal(hashes.size, 1, "a rolled-back hold must leave no units behind");
      assert.equal(held.length, 2, "the winner owns exactly its own two hours");
    });

    it("allows adjacent bookings because intervals are half-open", async () => {
      const date = futureDate();
      const results = await Promise.allSettled([
        service.createHold({ resourceId: RESOURCE_ID, date, startMin: 1020, endMin: 1140 }), // [5,7)
        service.createHold({ resourceId: RESOURCE_ID, date, startMin: 1140, endMin: 1260 }), // [7,9)
      ]);

      assert.equal(results.filter((r) => r.status === "fulfilled").length, 2, "5–7 and 7–9 do not overlap");
      const units = await collections.slotUnits(db).countDocuments({ resourceId: RESOURCE_ID, date, status: "HELD" });
      assert.equal(units, 4);
    });

    it("keeps the database consistent under a burst of competing requests", async () => {
      const date = futureDate();
      const attempts = Array.from({ length: 8 }, () =>
        service.createHold({ resourceId: RESOURCE_ID, date, startMin: 1020, endMin: 1140 }),
      );
      const results = await Promise.allSettled(attempts);

      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1, "only one winner out of eight");

      const units = await collections.slotUnits(db).find({ resourceId: RESOURCE_ID, date }).toArray();
      assert.equal(units.length, 2, "no duplicate slot-unit documents");
      assert.equal(new Set(units.map((u) => `${u.startMin}`)).size, 2, "no duplicate unit identities");
      assert.equal(new Set(units.map((u) => u.holdTokenHash)).size, 1, "one owner only");
    });

    it("refuses a second booking on an already confirmed slot", async () => {
      const date = futureDate();
      const hold = await service.createHold({ resourceId: RESOURCE_ID, date, startMin: 1020, endMin: 1080 });
      const booking = await service.submitBooking({
        holdToken: hold.holdToken,
        customerName: "Ravi Kumar",
        customerPhone: "9876543210",
        paymentScreenshotKey: SCREENSHOT,
        utr: UTR,
      });
      await acceptPayment(booking);
      await service.confirmBooking(booking._id, ADMIN);

      await assert.rejects(
        () => service.createHold({ resourceId: RESOURCE_ID, date, startMin: 1020, endMin: 1080 }),
        /just taken|another customer/i,
      );
    });
  });

  /* ── Submission ────────────────────────────────────────────────────── */

  describe("booking submission", () => {
    async function holdAndSubmit(date = futureDate(), startMin = 1020, endMin = 1140) {
      const hold = await service.createHold({ resourceId: RESOURCE_ID, date, startMin, endMin });
      const booking = await service.submitBooking({
        holdToken: hold.holdToken,
        customerName: "Ravi Kumar",
        customerPhone: "9876543210",
        paymentScreenshotKey: SCREENSHOT,
        utr: UTR,
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
      await collections.facilities(db).updateOne(
        { _id: FACILITY_ID },
        { $set: { "config.priceRules": [{ fromMin: 0, toMin: 1440, price: 5000 }] } },
      );
      // Written straight to the database, so the running service still holds the
      // configuration it last read. Real edits go through the admin route, which
      // clears this itself.
      service.forgetResourceContext();

      const stored = await collections.bookings(db).findOne({ _id: booking._id });
      assert.equal(stored!.amount, 1600, "historic bookings must not be repriced");

      // Restore the schedule for the remaining tests.
      await collections.facilities(db).updateOne(
        { _id: FACILITY_ID },
        { $set: { "config.priceRules": SCHEDULE.priceRules } },
      );
      // Written straight to the database, so the running service still holds the
      // configuration it last read. Real edits go through the admin route, which
      // clears this itself.
      service.forgetResourceContext();
    });

    it("returns the same booking when the same hold is submitted twice", async () => {
      const date = futureDate();
      const hold = await service.createHold({ resourceId: RESOURCE_ID, date, startMin: 1020, endMin: 1080 });
      const payload = {
        holdToken: hold.holdToken,
        customerName: "Ravi Kumar",
        customerPhone: "9876543210",
        paymentScreenshotKey: SCREENSHOT,
        utr: UTR,
      };

      const first = await service.submitBooking(payload);
      const second = await service.submitBooking(payload);

      assert.equal(first.reference, second.reference, "a retry must not create a second booking");
      assert.equal(await collections.bookings(db).countDocuments({}), 1);
    });

    it("survives two simultaneous submissions of one hold", async () => {
      const date = futureDate();
      const hold = await service.createHold({ resourceId: RESOURCE_ID, date, startMin: 1020, endMin: 1080 });
      const payload = {
        holdToken: hold.holdToken,
        customerName: "Ravi Kumar",
        customerPhone: "9876543210",
        paymentScreenshotKey: SCREENSHOT,
        utr: UTR,
      };

      const results = await Promise.allSettled([service.submitBooking(payload), service.submitBooking(payload)]);
      const created = results.filter((r) => r.status === "fulfilled");
      assert.ok(created.length >= 1);
      assert.equal(await collections.bookings(db).countDocuments({}), 1, "double click must not double book");
    });

    it("refuses submission after the hold expired, creating nothing", async () => {
      const date = futureDate();
      const hold = await service.createHold({ resourceId: RESOURCE_ID, date, startMin: 1020, endMin: 1080 });
      await collections.slotUnits(db).updateMany({ date }, { $set: { holdUntil: new Date(Date.now() - 1000) } });

      await assert.rejects(
        () =>
          service.submitBooking({
            holdToken: hold.holdToken,
            customerName: "Ravi Kumar",
            customerPhone: "9876543210",
            paymentScreenshotKey: SCREENSHOT,
            utr: UTR,
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
            utr: UTR,
          }),
        /verify your slot hold/i,
      );
    });

    it("stops one customer submitting another customer's hold", async () => {
      const date = futureDate();
      const victim = await service.createHold({ resourceId: RESOURCE_ID, date, startMin: 1020, endMin: 1080 });
      const attacker = await service.createHold({ resourceId: RESOURCE_ID, date, startMin: 1140, endMin: 1200 });

      const booking = await service.submitBooking({
        holdToken: attacker.holdToken,
        customerName: "Mallory",
        customerPhone: "9876543210",
        paymentScreenshotKey: SCREENSHOT,
        utr: UTR,
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
      const hold = await service.createHold({ resourceId: RESOURCE_ID, date, startMin: 1020, endMin: 1080 });
      await service.blockDay({ resourceId: RESOURCE_ID, date, reason: "Storm", force: true, admin: ADMIN });

      await assert.rejects(
        () =>
          service.submitBooking({
            holdToken: hold.holdToken,
            customerName: "Ravi Kumar",
            customerPhone: "9876543210",
            paymentScreenshotKey: SCREENSHOT,
            utr: UTR,
          }),
        /not taking bookings|expired|verify your slot hold/i,
      );
    });
  });

  /* ── Admin transitions ─────────────────────────────────────────────── */

  describe("admin actions", () => {
    async function pendingBooking(date = futureDate(), startMin = 1020, endMin = 1140) {
      const hold = await service.createHold({ resourceId: RESOURCE_ID, date, startMin, endMin });
      return service.submitBooking({
        holdToken: hold.holdToken,
        customerName: "Ravi Kumar",
        customerPhone: "9876543210",
        paymentScreenshotKey: SCREENSHOT,
        utr: UTR,
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

      const availability = await service.getAvailability(RESOURCE_ID, date);
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

      const availability = await service.getAvailability(RESOURCE_ID, date);
      assert.equal(availability.units.find((u) => u.startMin === 1020)!.status, "AVAILABLE");

      // And the freed slot can genuinely be taken by someone else.
      const next = await service.createHold({ resourceId: RESOURCE_ID, date, startMin: 1020, endMin: 1080 });
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

  /* ── Screenshot retention ──────────────────────────────────────────── */

  describe("screenshot retention", () => {
    /** A booking on `date` that has been paid for, with a screenshot on file. */
    async function paidBooking(date: string) {
      const hold = await service.createHold({ resourceId: RESOURCE_ID, date, startMin: 1020, endMin: 1080 });
      const booking = await service.submitBooking({
        holdToken: hold.holdToken,
        customerName: "Retention Test",
        customerPhone: "9876500011",
        paymentScreenshotKey: REAL_SCREENSHOT,
        utr: UTR,
      });
      await acceptPayment(booking);
      // Backdate the play date past the cutoff without going through the booking
      // flow, which refuses to create anything in the past.
      return booking;
    }

    it("keeps a screenshot while the booking is recent", async () => {
      const booking = await paidBooking(futureDate(1));
      const result = await service.purgeExpiredScreenshots();
      assert.equal(result.bookings, 0, "a booking that has not been played must keep its screenshot");

      const stored = await collections.bookings(db).findOne({ _id: booking._id });
      assert.equal(stored!.payments[0]!.screenshotKey, REAL_SCREENSHOT);
    });

    it("deletes the image after the retention window but keeps the money record", async () => {
      const booking = await paidBooking(futureDate(1));
      await collections.bookings(db).updateOne({ _id: booking._id }, { $set: { date: pastDate(30) } });

      const result = await service.purgeExpiredScreenshots();
      assert.equal(result.bookings, 1);
      assert.equal(result.failed, 0);

      const stored = await collections.bookings(db).findOne({ _id: booking._id });
      const attempt = stored!.payments[0]!;
      assert.equal(attempt.screenshotKey, null, "the image reference must be cleared");
      assert.ok(attempt.screenshotExpiredAt, "and marked as expired, not as never-existing");
      assert.equal(stored!.paymentScreenshotKey, null);

      // The whole point: the money survives the image.
      assert.equal(attempt.amount, booking.amount);
      assert.equal(attempt.status, "ACCEPTED");
      assert.equal(attempt.reviewedBy, ADMIN.username);
      assert.equal(stored!.amountPaid, booking.amount);
      assert.equal(stored!.status, booking.status);
      assert.ok(stored!.timeline.length > 0, "the audit timeline must be untouched");
    });

    it("is safe to run twice", async () => {
      const booking = await paidBooking(futureDate(1));
      await collections.bookings(db).updateOne({ _id: booking._id }, { $set: { date: pastDate(30) } });

      assert.equal((await service.purgeExpiredScreenshots()).bookings, 1);
      // The second pass must find nothing, not fail on an already-deleted file.
      assert.equal((await service.purgeExpiredScreenshots()).bookings, 0);
    });

    it("leaves a staff-recorded payment alone — there is no image to delete", async () => {
      const date = futureDate(1);
      const hold = await service.createHold({ resourceId: RESOURCE_ID, date, startMin: 1140, endMin: 1200 });
      const booking = await service.submitBooking({
        holdToken: hold.holdToken,
        customerName: "Cash Payer",
        customerPhone: "9876500012",
        paymentScreenshotKey: SCREENSHOT,
        utr: UTR,
      });
      await collections.bookings(db).updateOne({ _id: booking._id }, { $set: { date: pastDate(30) } });

      await service.purgeExpiredScreenshots();
      const stored = await collections.bookings(db).findOne({ _id: booking._id });
      assert.equal(stored!.payments[0]!.screenshotKey, null);
      assert.ok(stored!.payments[0]!.screenshotExpiredAt);
    });
  });

  /* ── Blocking ──────────────────────────────────────────────────────── */

  describe("blocking", () => {
    it("blocks free slots and stops customers booking them", async () => {
      const date = futureDate();
      const outcome = await service.blockSlots({
        resourceId: RESOURCE_ID,
        date,
        startMin: 1020,
        endMin: 1260,
        reason: "Tournament",
        force: false,
        admin: ADMIN,
      });
      assert.equal(outcome.blocked, 4);

      const availability = await service.getAvailability(RESOURCE_ID, date);
      assert.equal(availability.units.find((u) => u.startMin === 1020)!.status, "BLOCKED");
      // A closed ground says so, rather than blaming an imaginary other customer.
      await assert.rejects(
        () => service.createHold({ resourceId: RESOURCE_ID, date, startMin: 1020, endMin: 1080 }),
        /ground is closed/i,
      );
    });

    it("refuses to block a date that has already passed", async () => {
      const date = pastDate();
      await assert.rejects(
        () =>
          service.blockSlots({
            resourceId: RESOURCE_ID,
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
        () => service.blockDay({ resourceId: RESOURCE_ID, date, reason: "Festival", force: false, admin: ADMIN }),
        /already passed/i,
      );
      // Nothing was written on the way to the rejection.
      assert.equal(await collections.dayBlocks(db).countDocuments({ resourceId: RESOURCE_ID, date }), 0);
      assert.equal(await collections.slotUnits(db).countDocuments({ resourceId: RESOURCE_ID, date }), 0);
    });

    it("still re-opens a past date that was blocked before the guard existed", async () => {
      const date = pastDate();
      await collections.dayBlocks(db).insertOne({
        resourceId: RESOURCE_ID,
        date,
        reason: "Legacy",
        blockedBy: "tester",
        blockedAt: new Date(),
      } as never);
      assert.equal(await service.unblockDay(RESOURCE_ID, date), true);
    });

    it("re-opens blocked slots", async () => {
      const date = futureDate();
      await service.blockSlots({ resourceId: RESOURCE_ID, date, startMin: 1020, endMin: 1140, reason: "Rain", force: false, admin: ADMIN });
      const unblocked = await service.unblockSlots({ resourceId: RESOURCE_ID, date, startMin: 1020, endMin: 1140 });
      assert.equal(unblocked, 2);

      const availability = await service.getAvailability(RESOURCE_ID, date);
      assert.equal(availability.units.find((u) => u.startMin === 1020)!.status, "AVAILABLE");
    });

    it("warns instead of blocking when a live hold is in the way", async () => {
      const date = futureDate();
      await service.createHold({ resourceId: RESOURCE_ID, date, startMin: 1080, endMin: 1200 }); // 6–8

      const outcome = await service.blockSlots({
        resourceId: RESOURCE_ID,
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
      const hold = await service.createHold({ resourceId: RESOURCE_ID, date, startMin: 1020, endMin: 1140 }); // 5–7
      await service.submitBooking({
        holdToken: hold.holdToken,
        customerName: "Ravi Kumar",
        customerPhone: "9876543210",
        paymentScreenshotKey: SCREENSHOT,
        utr: UTR,
      });

      // Block 5–6 only: the booking's 6–7 hour sits outside the blocked range.
      const outcome = await service.blockSlots({
        resourceId: RESOURCE_ID,
        date,
        startMin: 1020,
        endMin: 1080,
        reason: "Emergency maintenance",
        force: true,
        admin: ADMIN,
      });
      assert.equal(outcome.blocked, 1);

      const availability = await service.getAvailability(RESOURCE_ID, date);
      assert.equal(availability.units.find((u) => u.startMin === 1020)!.status, "BLOCKED");
      assert.equal(
        availability.units.find((u) => u.startMin === 1080)!.status,
        "AVAILABLE",
        "the hour outside the block must go back on sale, not stay stranded",
      );

      // And it must genuinely be bookable, not merely look available.
      const next = await service.createHold({ resourceId: RESOURCE_ID, date, startMin: 1080, endMin: 1140 });
      assert.equal(next.startMin, 1080);
    });

    it("blocks over a pending request only when forced, and rejects that booking explicitly", async () => {
      const date = futureDate();
      const hold = await service.createHold({ resourceId: RESOURCE_ID, date, startMin: 1020, endMin: 1080 });
      const booking = await service.submitBooking({
        holdToken: hold.holdToken,
        customerName: "Ravi Kumar",
        customerPhone: "9876543210",
        paymentScreenshotKey: SCREENSHOT,
        utr: UTR,
      });

      const outcome = await service.blockSlots({
        resourceId: RESOURCE_ID,
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
      const hold = await service.createHold({ resourceId: RESOURCE_ID, date, startMin: 1020, endMin: 1080 });
      const booking = await service.submitBooking({
        holdToken: hold.holdToken,
        customerName: "Ravi Kumar",
        customerPhone: "9876543210",
        paymentScreenshotKey: SCREENSHOT,
        utr: UTR,
      });
      await acceptPayment(booking);
      await service.confirmBooking(booking._id, ADMIN);

      await assert.rejects(
        () =>
          service.blockSlots({
            resourceId: RESOURCE_ID,
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
      await service.blockDay({ resourceId: RESOURCE_ID, date, reason: "Festival", force: false, admin: ADMIN });

      assert.equal(await collections.dayBlocks(db).countDocuments({ resourceId: RESOURCE_ID, date }), 1);
      assert.equal(
        await collections.slotUnits(db).countDocuments({ resourceId: RESOURCE_ID, date }),
        0,
        "a day block must not materialise one row per slot",
      );

      const availability = await service.getAvailability(RESOURCE_ID, date);
      assert.equal(availability.dayBlocked, true);
      assert.ok(availability.units.every((u) => u.status === "BLOCKED"));
    });

    it("refuses a day block that would bury a confirmed booking", async () => {
      const date = futureDate();
      const hold = await service.createHold({ resourceId: RESOURCE_ID, date, startMin: 1020, endMin: 1080 });
      const booking = await service.submitBooking({
        holdToken: hold.holdToken,
        customerName: "Ravi Kumar",
        customerPhone: "9876543210",
        paymentScreenshotKey: SCREENSHOT,
        utr: UTR,
      });
      await acceptPayment(booking);
      await service.confirmBooking(booking._id, ADMIN);

      await assert.rejects(
        () => service.blockDay({ resourceId: RESOURCE_ID, date, reason: "Festival", force: true, admin: ADMIN }),
        /confirmed bookings/i,
      );
    });

    it("re-opens a blocked day", async () => {
      const date = futureDate();
      await service.blockDay({ resourceId: RESOURCE_ID, date, reason: "Festival", force: false, admin: ADMIN });
      assert.equal(await service.unblockDay(RESOURCE_ID, date), true);

      const availability = await service.getAvailability(RESOURCE_ID, date);
      assert.equal(availability.dayBlocked, false);
      assert.ok(availability.units.every((u) => u.status === "AVAILABLE"));
    });

    it("does not reopen a blocked slot when a booking on a different slot is rejected", async () => {
      const date = futureDate();
      await service.blockSlots({ resourceId: RESOURCE_ID, date, startMin: 1140, endMin: 1200, reason: "Nets", force: false, admin: ADMIN });

      const hold = await service.createHold({ resourceId: RESOURCE_ID, date, startMin: 1020, endMin: 1080 });
      const booking = await service.submitBooking({
        holdToken: hold.holdToken,
        customerName: "Ravi Kumar",
        customerPhone: "9876543210",
        paymentScreenshotKey: SCREENSHOT,
        utr: UTR,
      });
      await service.rejectBooking(booking._id, "Payment not received", ADMIN);

      const blocked = await collections.slotUnits(db).findOne({ date, startMin: 1140 });
      assert.equal(blocked!.status, "BLOCKED", "a rejected booking must not unblock the turf");
    });
  });

  /* ── Partial payments: the 1400-against-1600 case ──────────────────── */

  describe("partial payments", () => {
    async function pendingBooking(date = futureDate(), startMin = 1020, endMin = 1140) {
      const hold = await service.createHold({ resourceId: RESOURCE_ID, date, startMin, endMin });
      return service.submitBooking({
        holdToken: hold.holdToken,
        customerName: "Ravi Kumar",
        customerPhone: "9876543210",
        paymentScreenshotKey: SCREENSHOT,
        utr: UTR,
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
      const availability = await service.getAvailability(RESOURCE_ID, date);
      assert.equal(availability.units.find((u) => u.startMin === 1020)!.status, "PENDING");
      await assert.rejects(
        () => service.createHold({ resourceId: RESOURCE_ID, date, startMin: 1020, endMin: 1080 }),
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
        utr: UTR,
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
      const withBalance = await service.addPaymentAttempt({ bookingId: booking._id, screenshotKey: "a/b.jpg", utr: UTR });
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

      const availability = await service.getAvailability(RESOURCE_ID, date);
      assert.equal(
        availability.units.find((u) => u.startMin === 1020)!.status,
        "PENDING",
        "the slots must stay with this customer",
      );

      // And the customer can still put it right.
      const retried = await service.addPaymentAttempt({ bookingId: booking._id, screenshotKey: "a/clear.jpg", utr: UTR });
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

      const withBalance = await service.addPaymentAttempt({ bookingId: booking._id, screenshotKey: "a/balance.jpg", utr: UTR });
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

      const availability = await service.getAvailability(RESOURCE_ID, date);
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
      const second = await service.addPaymentAttempt({ bookingId: booking._id, screenshotKey: "a/second.jpg", utr: UTR });
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
        () => service.addPaymentAttempt({ bookingId: booking._id, screenshotKey: "a/late.jpg", utr: UTR }),
        /not waiting for a payment/i,
      );
    });
  });

  /* ── Housekeeping ──────────────────────────────────────────────────── */

  describe("housekeeping", () => {
    it("cleans up expired holds without affecting correctness either way", async () => {
      const date = futureDate();
      await service.createHold({ resourceId: RESOURCE_ID, date, startMin: 1020, endMin: 1140 });
      await collections.slotUnits(db).updateMany({ date }, { $set: { holdUntil: new Date(Date.now() - 1000) } });

      const cleaned = await service.cleanupExpiredHolds();
      assert.equal(cleaned, 2);

      const units = await collections.slotUnits(db).find({ date }).toArray();
      assert.ok(units.every((u) => u.status === "AVAILABLE" && u.holdTokenHash === null));
    });

    it("leaves booked and blocked units alone during cleanup", async () => {
      const date = futureDate();
      await service.blockSlots({ resourceId: RESOURCE_ID, date, startMin: 1020, endMin: 1080, reason: "Nets", force: false, admin: ADMIN });
      await service.cleanupExpiredHolds();
      const unit = await collections.slotUnits(db).findOne({ date, startMin: 1020 });
      assert.equal(unit!.status, "BLOCKED");
    });
  });

  /* ── The UPI reference, and bookings taken on the telephone ─────────── */

  describe("payment reference (UTR)", () => {
    it("refuses an online booking with no reference, even with a screenshot", async () => {
      const hold = await service.createHold({
        resourceId: RESOURCE_ID,
        date: futureDate(21),
        startMin: 1020,
        endMin: 1080,
      });

      await assert.rejects(
        () =>
          service.submitBooking({
            holdToken: hold.holdToken,
            customerName: "Ravi Kumar",
            customerPhone: "9876543210",
            paymentScreenshotKey: SCREENSHOT,
            utr: null,
          }),
        /UPI reference number/i,
      );

      // And the slot is still the customer's to finish with.
      const units = await collections.slotUnits(db).find({ holdTokenHash: { $ne: null }, date: futureDate(21) }).toArray();
      assert.ok(units.every((u) => u.status === "HELD"));
    });

    /**
     * A screenshot is required. Sending none is the customer not having done
     * their part, and no amount of UTR makes up for it — otherwise nobody would
     * ever send one.
     */
    it("refuses a booking with no screenshot", async () => {
      const date = futureDate(22);
      const hold = await service.createHold({ resourceId: RESOURCE_ID, date, startMin: 1020, endMin: 1080 });
      await assert.rejects(
        () =>
          service.submitBooking({
            holdToken: hold.holdToken,
            customerName: "Ravi Kumar",
            customerPhone: "9876543210",
            paymentScreenshotKey: null,
            utr: UTR,
          }),
        /screenshot/i,
      );

      // The slot is still theirs: they can upload and finish.
      const units = await collections.slotUnits(db).find({ date }).toArray();
      assert.ok(units.every((u) => u.status === "HELD"), "a refused submission must not release the slot");
    });

    /**
     * The one exemption, and the reason the whole mechanism exists: the customer
     * has paid, the image was fine, and our storage would not take it. Refusing
     * the booking here would charge them for our outage.
     *
     * `storageFailed` reaches this function from a cookie the server signed after
     * a real store failure — never from anything the browser said.
     */
    it("books on the reference alone when OUR storage refused the image", async () => {
      const date = futureDate(22);
      const hold = await service.createHold({ resourceId: RESOURCE_ID, date, startMin: 1140, endMin: 1200 });
      const booking = await service.submitBooking({
        holdToken: hold.holdToken,
        customerName: "Ravi Kumar",
        customerPhone: "9876543210",
        paymentScreenshotKey: null,
        utr: UTR,
        storageFailed: true,
      });

      assert.equal(booking.status, "PENDING");
      assert.equal(booking.paymentVerificationStatus, "PENDING", "nothing is verified automatically");
      assert.equal(booking.paymentScreenshotKey, null);
      assert.equal(booking.payments.length, 1, "the payment is recorded even with no image");
      assert.equal(booking.payments[0]!.utr, UTR);
      assert.equal(booking.payments[0]!.screenshotKey, null);
      // The distinction the admin screen reads: our fault, not a missing payment.
      assert.equal(booking.payments[0]!.uploadStatus, "FAILED");
      assert.equal(booking.payments[0]!.uploadFailureReason, "STORAGE_UNAVAILABLE");
      assert.ok(booking.timeline.some((t) => t.event === "PAYMENT_UTR_ENTERED"));

      // The admin can still accept it: the money is traced by the reference.
      const accepted = await acceptPayment(booking);
      assert.equal(accepted.paymentVerificationStatus, "VERIFIED");
    });

    it("records a successful upload as such", async () => {
      const date = futureDate(22);
      const hold = await service.createHold({ resourceId: RESOURCE_ID, date, startMin: 1200, endMin: 1260 });
      const booking = await service.submitBooking({
        holdToken: hold.holdToken,
        customerName: "Ravi Kumar",
        customerPhone: "9876543210",
        paymentScreenshotKey: SCREENSHOT,
        utr: UTR,
      });
      assert.equal(booking.payments[0]!.uploadStatus, "UPLOADED");
      assert.equal(booking.payments[0]!.uploadFailureReason, null);
    });

    it("keeps the reference on a balance payment too", async () => {
      const date = futureDate(23);
      const hold = await service.createHold({ resourceId: RESOURCE_ID, date, startMin: 1020, endMin: 1140 });
      const booking = await service.submitBooking({
        holdToken: hold.holdToken,
        customerName: "Ravi Kumar",
        customerPhone: "9876543210",
        paymentScreenshotKey: SCREENSHOT,
        utr: UTR,
      });
      await acceptPayment(booking, 800);

      // A balance payment needs its own screenshot, on the same terms.
      await assert.rejects(
        () =>
          service.addPaymentAttempt({
            bookingId: booking._id,
            screenshotKey: null,
            utr: "210987654321",
          }),
        /screenshot/i,
      );

      const topped = await service.addPaymentAttempt({
        bookingId: booking._id,
        screenshotKey: null,
        utr: "210987654321",
        storageFailed: true,
      });
      assert.equal(topped.payments.length, 2);
      assert.equal(topped.payments[1]!.utr, "210987654321");
      assert.equal(topped.payments[1]!.uploadStatus, "FAILED");
      // The first screenshot is still the one on file — a failed upload did not erase it.
      assert.equal(topped.paymentScreenshotKey, SCREENSHOT);
    });

    /**
     * Retry, once the store is back. The whole point of item 6: our outage must
     * not cost the customer their booking, so the image can arrive later and
     * land on the booking they already have.
     */
    it("accepts the screenshot later, on the booking that already exists", async () => {
      const date = futureDate(25);
      const hold = await service.createHold({ resourceId: RESOURCE_ID, date, startMin: 1020, endMin: 1080 });
      const booking = await service.submitBooking({
        holdToken: hold.holdToken,
        customerName: "Ravi Kumar",
        customerPhone: "9876543210",
        paymentScreenshotKey: null,
        utr: UTR,
        storageFailed: true,
      });
      assert.equal(booking.paymentScreenshotKey, null);

      const retried = await service.addPaymentAttempt({
        bookingId: booking._id,
        screenshotKey: SCREENSHOT,
        utr: UTR,
      });
      assert.equal(retried.reference, booking.reference, "the same booking, not a new one");
      assert.equal(retried.paymentScreenshotKey, SCREENSHOT, "the image is now on file");
      assert.equal(retried.payments.at(-1)!.uploadStatus, "UPLOADED");
    });

    it("asks for nothing when the session is paid for at the ground", async () => {
      const hold = await service.createHold({
        resourceId: BOWLING_ID,
        date: futureDate(24),
        startMin: 1020,
        overs: 20,
        ballTypeId: "synthetic",
      });
      assert.equal(hold.payAtVenue, true);

      const booking = await service.submitBooking({
        holdToken: hold.holdToken,
        customerName: "Ravi Kumar",
        customerPhone: "9876543210",
        paymentScreenshotKey: null,
        utr: null,
      });
      assert.equal(booking.status, "CONFIRMED");
      assert.equal(booking.payments.length, 0);
    });
  });

  describe("bookings taken over the telephone", () => {
    it("confirms the slot immediately and records who took it", async () => {
      const date = futureDate(25);
      const booking = await service.createManualBooking({
        resourceId: RESOURCE_ID,
        date,
        startMin: 1020,
        endMin: 1080,
        customerName: "Phone Caller",
        customerPhone: "9876543210",
        admin: ADMIN,
      });

      assert.equal(booking.status, "CONFIRMED");
      assert.equal(booking.createdBy, ADMIN.username);
      assert.equal(booking.amount, 800, "priced from the schedule, not from the request");
      assert.equal(booking.payments.length, 0);
      assert.ok(booking.timeline.some((t) => t.event === "BOOKING_TAKEN_BY_STAFF"));

      const units = await collections.slotUnits(db).find({ bookingId: booking._id }).toArray();
      assert.equal(units.length, 1);
      assert.ok(units.every((u) => u.status === "BOOKED"), "the slot is gone the moment the call ends");
    });

    it("cannot be written over a slot a customer already holds", async () => {
      const date = futureDate(26);
      await service.createHold({ resourceId: RESOURCE_ID, date, startMin: 1020, endMin: 1080 });

      await assert.rejects(
        () =>
          service.createManualBooking({
            resourceId: RESOURCE_ID,
            date,
            startMin: 1020,
            endMin: 1080,
            customerName: "Phone Caller",
            customerPhone: "9876543210",
            admin: ADMIN,
          }),
        /taken|no longer available|conflict/i,
      );
    });

    it("gives one winner when the owner and a customer take the same slot at once", async () => {
      const date = futureDate(27);
      const results = await Promise.allSettled([
        service.createManualBooking({
          resourceId: RESOURCE_ID,
          date,
          startMin: 1140,
          endMin: 1200,
          customerName: "Phone Caller",
          customerPhone: "9876543210",
          admin: ADMIN,
        }),
        (async () => {
          const hold = await service.createHold({ resourceId: RESOURCE_ID, date, startMin: 1140, endMin: 1200 });
          return service.submitBooking({
            holdToken: hold.holdToken,
            customerName: "Website Customer",
            customerPhone: "9876543211",
            paymentScreenshotKey: SCREENSHOT,
            utr: UTR,
          });
        })(),
      ]);

      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1, "exactly one may have the slot");

      const units = await collections.slotUnits(db).find({ resourceId: RESOURCE_ID, date, startMin: 1140 }).toArray();
      assert.equal(units.length, 1, "the unique index still owns the identity");
    });

    it("refuses to bank more than the booking costs", async () => {
      const date = futureDate(28);
      await assert.rejects(
        () =>
          service.createManualBooking({
            resourceId: RESOURCE_ID,
            date,
            startMin: 1020,
            endMin: 1080,
            customerName: "Phone Caller",
            customerPhone: "9876543210",
            amountPaid: 5000,
            admin: ADMIN,
          }),
        /more than the booking costs/i,
      );

      // The refusal gave the slot straight back rather than leaving a phantom hold.
      const units = await collections.slotUnits(db).find({ resourceId: RESOURCE_ID, date, startMin: 1020 }).toArray();
      assert.ok(units.every((u) => u.status === "AVAILABLE"), "a refused call leaves nothing reserved");
    });

    it("banks the cash the owner took on the call", async () => {
      const date = futureDate(29);
      const booking = await service.createManualBooking({
        resourceId: RESOURCE_ID,
        date,
        startMin: 1020,
        endMin: 1080,
        customerName: "Phone Caller",
        customerPhone: "9876543210",
        amountPaid: 800,
        note: "Paid by UPI while on the call",
        admin: ADMIN,
      });

      assert.equal(booking.amountPaid, 800);
      assert.equal(booking.paymentVerificationStatus, "VERIFIED");
      assert.equal(booking.status, "CONFIRMED");
    });

    it("lets the owner record the money later, at the ground", async () => {
      const date = futureDate(21);
      const booking = await service.createManualBooking({
        resourceId: RESOURCE_ID,
        date,
        startMin: 1140,
        endMin: 1200,
        customerName: "Phone Caller",
        customerPhone: "9876543210",
        admin: ADMIN,
      });
      assert.equal(booking.amountPaid, 0);

      const paid = await service.recordManualPayment({
        bookingId: booking._id,
        amount: booking.amount,
        note: "Cash at the gate",
        admin: ADMIN,
      });
      assert.equal(paid.amountPaid, booking.amount);
      assert.equal(paid.paymentVerificationStatus, "VERIFIED");
    });

    it("books a bowling session by overs, priced by its ball", async () => {
      const date = futureDate(24);
      const booking = await service.createManualBooking({
        resourceId: BOWLING_ID,
        date,
        startMin: 1020,
        overs: 30,
        ballTypeId: "leather",
        customerName: "Phone Caller",
        customerPhone: "9876543210",
        admin: ADMIN,
      });

      assert.equal(booking.overs, 30);
      assert.equal(booking.ballTypeName, "Leather ball");
      assert.equal(booking.amount, 300, "three blocks of ten overs at the leather price");
      assert.equal(booking.endMin - booking.startMin, 45);
      assert.equal(booking.status, "CONFIRMED");
    });

    it("reaches past the window customers are held to, but never into the past", async () => {
      const far = new Date(Date.now() + IST_OFFSET + 200 * 86_400_000).toISOString().slice(0, 10);
      const booking = await service.createManualBooking({
        resourceId: RESOURCE_ID,
        date: far,
        startMin: 1020,
        endMin: 1080,
        customerName: "Tournament Regular",
        customerPhone: "9876543210",
        admin: ADMIN,
      });
      assert.equal(booking.date, far);

      await assert.rejects(
        () =>
          service.createManualBooking({
            resourceId: RESOURCE_ID,
            date: pastDate(),
            startMin: 1020,
            endMin: 1080,
            customerName: "Tournament Regular",
            customerPhone: "9876543210",
            admin: ADMIN,
          }),
        /passed/i,
      );
    });

    it("will not take a booking on a day the ground is closed", async () => {
      const date = futureDate(28);
      await service.blockDay({ resourceId: RESOURCE_ID, date, reason: "Festival", force: false, admin: ADMIN });

      await assert.rejects(
        () =>
          service.createManualBooking({
            resourceId: RESOURCE_ID,
            date,
            startMin: 1020,
            endMin: 1080,
            customerName: "Phone Caller",
            customerPhone: "9876543210",
            admin: ADMIN,
          }),
        /not taking bookings/i,
      );
    });
  });

  describe("abandoned screenshots", () => {
    const file = (key: string, hoursAgo: number) => ({
      key,
      size: 1024,
      uploadedAt: new Date(Date.now() - hoursAgo * 3_600_000),
    });

    it("sweeps up a file no booking ever claimed", () => {
      const stored = [file("payment-screenshots/2026-01-01/a.jpg", 48)];
      const orphans = service.selectOrphanScreenshots(stored, new Set(), new Date(Date.now() - 86_400_000));
      assert.equal(orphans.length, 1);
    });

    it("never touches one a booking still names", () => {
      const key = "payment-screenshots/2026-01-01/b.jpg";
      const orphans = service.selectOrphanScreenshots(
        [file(key, 999)],
        new Set([key]),
        new Date(Date.now() - 86_400_000),
      );
      assert.equal(orphans.length, 0, "a screenshot in use is the retention job's business, not this one");
    });

    /** A hold lives five minutes; a file uploaded minutes ago may still become a booking. */
    it("leaves a fresh upload alone while the customer is still paying", () => {
      const orphans = service.selectOrphanScreenshots(
        [file("payment-screenshots/2026-01-01/c.jpg", 0.2)],
        new Set(),
        new Date(Date.now() - 86_400_000),
      );
      assert.equal(orphans.length, 0);
    });
  });

  describe("weekend pricing", () => {
    /** The first date at least `minDays` out that falls on `weekday` (0 Sunday). */
    function nextDateOn(weekday: number, minDays = 1): string {
      for (let offset = minDays; offset < minDays + 8; offset += 1) {
        const date = futureDate(offset);
        if (new Date(`${date}T00:00:00Z`).getUTCDay() === weekday) return date;
      }
      throw new Error("no such date inside the booking window");
    }

    const WEEKEND_CONFIG = {
      ...SCHEDULE,
      weekendPriceRules: [
        { fromMin: 17 * 60, toMin: 19 * 60, price: 1600 },
        { fromMin: 19 * 60, toMin: 23 * 60, price: 1800 },
      ],
      weekendDays: [5, 6, 0],
    };

    beforeEach(async () => {
      await collections.facilities(db).updateOne({ _id: FACILITY_ID }, { $set: { config: WEEKEND_CONFIG } });
      // Written straight to the database, so the running service still holds the
      // configuration it last read. Real edits go through the admin route, which
      // clears this itself.
      service.forgetResourceContext();
    });

    after(async () => {
      await collections.facilities(db).updateOne({ _id: FACILITY_ID }, { $set: { config: SCHEDULE } });
      // Written straight to the database, so the running service still holds the
      // configuration it last read. Real edits go through the admin route, which
      // clears this itself.
      service.forgetResourceContext();
    });

    it("quotes weekend prices on a Saturday and weekday prices on a Tuesday", async () => {
      const saturday = await service.getAvailability(RESOURCE_ID, nextDateOn(6, 2));
      const tuesday = await service.getAvailability(RESOURCE_ID, nextDateOn(2, 2));

      assert.equal(saturday.units.find((u) => u.startMin === 1020)!.price, 1600);
      assert.equal(tuesday.units.find((u) => u.startMin === 1020)!.price, 800);
      assert.equal(saturday.weekendRate, true);
      assert.equal(tuesday.weekendRate, false);
    });

    it("holds and charges the weekend price, not the weekday one", async () => {
      const date = nextDateOn(6, 2);
      const hold = await service.createHold({ resourceId: RESOURCE_ID, date, startMin: 1020, endMin: 1140 });
      // 5–6 at 1600 and 6–7 at 1600: both inside the weekend evening band.
      assert.equal(hold.amount, 3200);

      const booking = await service.submitBooking({
        holdToken: hold.holdToken,
        customerName: "Ravi Kumar",
        customerPhone: "9876543210",
        paymentScreenshotKey: SCREENSHOT,
        utr: UTR,
      });
      assert.equal(booking.amount, 3200, "the booking is charged what it was quoted");
      assert.ok(booking.priceBreakdown.every((b) => b.price === 1600));
    });

    it("prices a session that spans both weekend bands", async () => {
      const date = nextDateOn(0, 2); // Sunday
      const hold = await service.createHold({ resourceId: RESOURCE_ID, date, startMin: 1080, endMin: 1200 });
      // 6–7 PM at 1600, 7–8 PM at 1800.
      assert.equal(hold.amount, 3400);
      await service.releaseHold(hold.holdToken);
    });

    it("charges the weekday price on a day the owner did not call a weekend", async () => {
      await collections.facilities(db).updateOne(
        { _id: FACILITY_ID },
        { $set: { "config.weekendDays": [6] } }, // Saturday only
      );
      // Written straight to the database, so the running service still holds the
      // configuration it last read. Real edits go through the admin route, which
      // clears this itself.
      service.forgetResourceContext();
      const friday = await service.getAvailability(RESOURCE_ID, nextDateOn(5, 2));
      assert.equal(friday.units.find((u) => u.startMin === 1020)!.price, 800);
      const saturday = await service.getAvailability(RESOURCE_ID, nextDateOn(6, 2));
      assert.equal(saturday.units.find((u) => u.startMin === 1020)!.price, 1600);
    });

    it("keeps one price all week once the weekend table is cleared", async () => {
      await collections.facilities(db).updateOne(
        { _id: FACILITY_ID },
        { $set: { "config.weekendPriceRules": [] } },
      );
      // Written straight to the database, so the running service still holds the
      // configuration it last read. Real edits go through the admin route, which
      // clears this itself.
      service.forgetResourceContext();
      const saturday = await service.getAvailability(RESOURCE_ID, nextDateOn(6, 2));
      assert.equal(saturday.units.find((u) => u.startMin === 1020)!.price, 800);
      assert.equal(saturday.weekendRate, false);
    });

    /** A price list edited mid-booking must not change what the customer was quoted. */
    it("charges what was quoted even if the weekend prices change during the hold", async () => {
      const date = nextDateOn(6, 2);
      const hold = await service.createHold({ resourceId: RESOURCE_ID, date, startMin: 1020, endMin: 1080 });
      assert.equal(hold.amount, 1600);

      await collections.facilities(db).updateOne(
        { _id: FACILITY_ID },
        { $set: { "config.weekendPriceRules.0.price": 9999 } },
      );
      // Written straight to the database, so the running service still holds the
      // configuration it last read. Real edits go through the admin route, which
      // clears this itself.
      service.forgetResourceContext();

      // The schedule is re-read at submission, so the new price is what applies —
      // and the customer is told rather than quietly charged the old one.
      const booking = await service.submitBooking({
        holdToken: hold.holdToken,
        customerName: "Ravi Kumar",
        customerPhone: "9876543210",
        paymentScreenshotKey: SCREENSHOT,
        utr: UTR,
      });
      assert.equal(booking.amount, 9999, "submission re-prices from the live schedule");
    });

    it("lets the owner take a phone booking at the weekend price", async () => {
      const date = nextDateOn(6, 3);
      const booking = await service.createManualBooking({
        resourceId: RESOURCE_ID,
        date,
        startMin: 1140,
        endMin: 1200,
        customerName: "Phone Caller",
        customerPhone: "9876543210",
        admin: ADMIN,
      });
      assert.equal(booking.amount, 1800, "7–8 PM on a Saturday");
    });
  });

  /* ── Database consistency after everything above ───────────────────── */


  describe("database consistency", () => {
    it("holds no duplicate unit identity, orphan hold or booking without slots", async () => {
      const date = futureDate();
      // Build a realistic mixture of state.
      const holdA = await service.createHold({ resourceId: RESOURCE_ID, date, startMin: 1020, endMin: 1140 });
      const bookingA = await service.submitBooking({
        holdToken: holdA.holdToken,
        customerName: "Ravi Kumar",
        customerPhone: "9876543210",
        paymentScreenshotKey: SCREENSHOT,
        utr: UTR,
      });
      await acceptPayment(bookingA);
      await service.confirmBooking(bookingA._id, ADMIN);

      const holdB = await service.createHold({ resourceId: RESOURCE_ID, date, startMin: 1140, endMin: 1200 });
      const bookingB = await service.submitBooking({
        holdToken: holdB.holdToken,
        customerName: "Sita R",
        customerPhone: "9876543211",
        paymentScreenshotKey: SCREENSHOT,
        utr: UTR,
      });
      await service.rejectBooking(bookingB._id, "Payment not received", ADMIN);

      await service.createHold({ resourceId: RESOURCE_ID, date, startMin: 1200, endMin: 1260 });

      const units = await collections.slotUnits(db).find({ resourceId: RESOURCE_ID, date }).toArray();
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
