import "server-only";
import crypto from "node:crypto";
import { ObjectId, type ClientSession, type Db } from "mongodb";
import { collections, getDb, getMongoClient, isDuplicateKeyError } from "@/lib/db";
import { appError, AppError } from "@/lib/errors";
import { log } from "@/lib/log";
import { daysFromToday, istDateString, istInstant, isValidBusinessDate } from "@/lib/time";
import type {
  BookingDoc,
  BookingTimelineEntry,
  PaymentAttempt,
  LocationDoc,
  PublicSlotStatus,
  SlotConfigDoc,
  SlotUnitDoc,
} from "@/lib/types";
import { buildDayTemplate, resolveUnits, totalPrice, type SlotUnitTemplate } from "./schedule";
import { generateBookingReference, generateHoldToken, hashHoldToken } from "./reference";

/** Used until an admin saves a per-location configuration. */
export const DEFAULT_SLOT_CONFIG = {
  slotMinutes: 60,
  openMin: 6 * 60,
  closeMin: 23 * 60,
  bookingWindowDays: 30,
  holdMinutes: 10,
  priceRules: [
    { fromMin: 6 * 60, toMin: 17 * 60, price: 800 },
    { fromMin: 17 * 60, toMin: 23 * 60, price: 1200 },
  ],
};

/* ──────────────────────────────────────────────────────────────────────────
 * Context loading
 * ────────────────────────────────────────────────────────────────────── */

export type EffectiveConfig = Pick<
  SlotConfigDoc,
  "slotMinutes" | "openMin" | "closeMin" | "priceRules" | "bookingWindowDays" | "holdMinutes"
>;

export interface LocationContext {
  location: LocationDoc;
  config: EffectiveConfig;
  template: SlotUnitTemplate[];
}

export async function loadLocationContext(
  db: Db,
  locationId: ObjectId,
  requireActive: boolean,
): Promise<LocationContext> {
  const location = await collections.locations(db).findOne({ _id: locationId });
  if (!location) throw appError("NOT_FOUND", "We could not find that location.");
  if (requireActive && !location.active) throw appError("LOCATION_INACTIVE");

  const stored = await collections.slotConfigs(db).findOne({ locationId });
  const config: EffectiveConfig = stored
    ? {
        slotMinutes: stored.slotMinutes,
        openMin: stored.openMin,
        closeMin: stored.closeMin,
        priceRules: stored.priceRules,
        bookingWindowDays: stored.bookingWindowDays,
        holdMinutes: stored.holdMinutes,
      }
    : { ...DEFAULT_SLOT_CONFIG };

  return { location, config, template: buildDayTemplate(config) };
}

/* ──────────────────────────────────────────────────────────────────────────
 * Availability
 * ────────────────────────────────────────────────────────────────────── */

export interface AvailabilityUnit {
  startMin: number;
  endMin: number;
  price: number;
  status: PublicSlotStatus;
}

export interface AvailabilityResult {
  locationId: string;
  locationName: string;
  date: string;
  slotMinutes: number;
  holdMinutes: number;
  dayBlocked: boolean;
  units: AvailabilityUnit[];
}

/**
 * A stored unit blocks new bookings only when it is genuinely taken RIGHT NOW.
 * An expired HELD row reads as available from this predicate alone, so
 * availability stays correct even if the cleanup job never runs.
 */
function liveStatus(unit: SlotUnitDoc | undefined, now: Date): PublicSlotStatus {
  if (!unit) return "AVAILABLE";
  if (unit.status === "HELD") {
    return unit.holdUntil && unit.holdUntil.getTime() > now.getTime() ? "HELD" : "AVAILABLE";
  }
  return unit.status;
}

/**
 * Blocking is an admin action, so it is not limited to the customer booking
 * window — a tournament may be months out. But a day that has already gone
 * cannot be blocked: the slots are history, nothing can be booked into them,
 * and the BLOCKED rows would sit in the calendar forever.
 */
export function assertNotPast(date: string, now: Date): void {
  if (!isValidBusinessDate(date)) throw appError("VALIDATION", "Please choose a valid date.");
  if (daysFromToday(date, now) < 0) {
    throw appError("PAST_DATE", "That date has already passed. Pick today or a later date.");
  }
}

export function assertBookableDate(date: string, bookingWindowDays: number, now: Date): void {
  if (!isValidBusinessDate(date)) throw appError("VALIDATION", "Please choose a valid date.");
  const offset = daysFromToday(date, now);
  if (offset < 0) throw appError("PAST_DATE", "That date has already passed. Please pick an upcoming date.");
  if (offset > bookingWindowDays) {
    throw appError(
      "OUTSIDE_WINDOW",
      `Bookings open ${bookingWindowDays} days in advance. Please pick an earlier date.`,
    );
  }
}

export async function getAvailability(
  locationId: ObjectId,
  date: string,
  now: Date = new Date(),
): Promise<AvailabilityResult> {
  const db = await getDb();
  const { location, config, template } = await loadLocationContext(db, locationId, true);
  assertBookableDate(date, config.bookingWindowDays, now);

  const [stored, dayBlock] = await Promise.all([
    collections.slotUnits(db).find({ locationId, date }).toArray(),
    collections.dayBlocks(db).findOne({ locationId, date }),
  ]);

  const byStart = new Map(stored.map((u) => [u.startMin, u]));
  const today = istDateString(now);

  const units: AvailabilityUnit[] = template.map((slot) => {
    let status: PublicSlotStatus = dayBlock ? "BLOCKED" : liveStatus(byStart.get(slot.startMin), now);
    // A slot whose start time has already passed is never bookable, including today.
    if (status === "AVAILABLE" && date <= today && istInstant(date, slot.startMin).getTime() <= now.getTime()) {
      status = "PAST";
    }
    return { startMin: slot.startMin, endMin: slot.endMin, price: slot.price, status };
  });

  return {
    locationId: locationId.toHexString(),
    locationName: location.name,
    date,
    slotMinutes: config.slotMinutes,
    holdMinutes: config.holdMinutes,
    dayBlocked: Boolean(dayBlock),
    units,
  };
}

/* ──────────────────────────────────────────────────────────────────────────
 * Transactions
 * ────────────────────────────────────────────────────────────────────── */

async function withTransaction<T>(fn: (session: ClientSession, db: Db) => Promise<T>): Promise<T> {
  const db = await getDb();
  const session = getMongoClient().startSession();
  try {
    // The driver retries TransientTransactionError and UnknownTransactionCommitResult.
    return await session.withTransaction(() => fn(session, db), {
      readConcern: { level: "snapshot" },
      writeConcern: { w: "majority" },
    });
  } finally {
    await session.endSession();
  }
}

/** Map a low-level failure onto a message a customer can act on. */
function rethrowBookingError(err: unknown, event: string, context: Record<string, unknown>): never {
  if (err instanceof AppError) throw err;
  if (isDuplicateKeyError(err)) {
    log.info(`${event}_conflict`, context);
    throw appError("SLOT_CONFLICT");
  }
  if (/replica set|Transaction numbers are only allowed/i.test((err as Error)?.message ?? "")) {
    // Loud, specific message: a standalone mongod cannot run transactions, and
    // without them the concurrency guarantees in this file do not hold.
    log.error("mongodb_not_a_replica_set", {
      hint: "MONGODB_URI must point at a replica set (every Atlas cluster is one). Transactions are required.",
    });
  }
  log.error(`${event}_failed`, { err, ...context });
  throw appError("INTERNAL", "Unable to process your booking right now. Please try again.");
}

/* ──────────────────────────────────────────────────────────────────────────
 * Holds
 * ────────────────────────────────────────────────────────────────────── */

export interface HoldResult {
  holdToken: string;
  holdUntil: Date;
  locationId: string;
  locationName: string;
  date: string;
  startMin: number;
  endMin: number;
  amount: number;
  breakdown: Array<{ startMin: number; endMin: number; price: number }>;
}

/**
 * Atomically reserve every atomic unit in [startMin, endMin) for `holdMinutes`.
 *
 * Why this is safe under concurrency:
 *  1. `slotUnits` carries a UNIQUE index on (locationId, date, startMin), so at
 *     most one document can ever exist for a unit.
 *  2. Each unit is claimed by a conditional upsert whose filter matches only a
 *     free unit (absent, AVAILABLE, or an expired HELD). When the unit is really
 *     taken the filter misses, the upsert falls through to an insert, and the
 *     unique index rejects it with E11000 — the database refuses the double
 *     booking, not application code.
 *  3. Every unit is claimed inside one transaction, so a multi-hour request is
 *     all-or-nothing: a conflict on the last unit rolls the earlier ones back.
 */
export async function createHold(input: {
  locationId: ObjectId;
  date: string;
  startMin: number;
  endMin: number;
  now?: Date;
}): Promise<HoldResult> {
  const now = input.now ?? new Date();
  const db = await getDb();
  const { location, config, template } = await loadLocationContext(db, input.locationId, true);

  assertBookableDate(input.date, config.bookingWindowDays, now);

  const units = resolveUnits(template, input.startMin, input.endMin);
  if (!units || units.length === 0) {
    throw appError("VALIDATION", "That time range is not bookable. Please pick from the listed slots.");
  }
  if (istInstant(input.date, input.startMin).getTime() <= now.getTime()) {
    throw appError("PAST_DATE", "That time has already passed. Please pick an upcoming slot.");
  }

  const holdToken = generateHoldToken();
  const holdTokenHash = hashHoldToken(holdToken);
  const holdUntil = new Date(now.getTime() + config.holdMinutes * 60_000);
  const context = {
    locationId: input.locationId.toHexString(),
    date: input.date,
    startMin: input.startMin,
    endMin: input.endMin,
  };

  try {
    await withTransaction(async (session, txDb) => {
      const dayBlock = await collections
        .dayBlocks(txDb)
        .findOne({ locationId: input.locationId, date: input.date }, { session });
      if (dayBlock) throw appError("DAY_BLOCKED");

      for (const unit of units) {
        await collections.slotUnits(txDb).updateOne(
          {
            locationId: input.locationId,
            date: input.date,
            startMin: unit.startMin,
            $or: [{ status: "AVAILABLE" }, { status: "HELD", holdUntil: { $lte: now } }],
          },
          {
            $set: {
              endMin: unit.endMin,
              status: "HELD",
              holdTokenHash,
              holdUntil,
              bookingId: null,
              price: unit.price,
              blockReason: null,
              blockedBy: null,
              blockedAt: null,
              updatedAt: now,
            },
            $setOnInsert: { createdAt: now },
          },
          { upsert: true, session },
        );
      }
    });
  } catch (err) {
    // "Taken by someone else" is wrong when the turf simply is not open then.
    // Work out which it was so the customer is told the truth.
    if (isDuplicateKeyError(err)) {
      const blocked = await collections.slotUnits(db).countDocuments({
        locationId: input.locationId,
        date: input.date,
        startMin: { $gte: input.startMin, $lt: input.endMin },
        status: "BLOCKED",
      });
      if (blocked > 0) {
        log.info("hold_blocked", context);
        throw appError("SLOT_CONFLICT", "This ground is closed at that time. Please choose another slot.");
      }
    }
    rethrowBookingError(err, "hold", context);
  }

  log.info("hold_created", context);

  return {
    holdToken,
    holdUntil,
    locationId: input.locationId.toHexString(),
    locationName: location.name,
    date: input.date,
    startMin: input.startMin,
    endMin: input.endMin,
    amount: totalPrice(units),
    breakdown: units.map((u) => ({ startMin: u.startMin, endMin: u.endMin, price: u.price })),
  };
}

export interface HoldSnapshot {
  holdUntil: Date;
  locationId: string;
  locationName: string;
  date: string;
  startMin: number;
  endMin: number;
  amount: number;
  breakdown: Array<{ startMin: number; endMin: number; price: number }>;
  /** Set when this hold was already turned into a booking — used for refresh recovery. */
  submittedBookingReference: string | null;
}

/** Recover a hold from its raw token: survives a refresh or a back navigation. */
export async function getHold(holdToken: string, now: Date = new Date()): Promise<HoldSnapshot | null> {
  const db = await getDb();
  const holdTokenHash = hashHoldToken(holdToken);
  const units = await collections.slotUnits(db).find({ holdTokenHash }).sort({ startMin: 1 }).toArray();
  if (units.length === 0) return null;

  const submitted = units.find((u) => u.bookingId);
  if (submitted) {
    const booking = await collections.bookings(db).findOne({ _id: submitted.bookingId! });
    if (booking) {
      return {
        holdUntil: now,
        locationId: booking.locationId.toHexString(),
        locationName: booking.locationName,
        date: booking.date,
        startMin: booking.startMin,
        endMin: booking.endMin,
        amount: booking.amount,
        breakdown: booking.priceBreakdown,
        submittedBookingReference: booking.reference,
      };
    }
  }

  const live = units.filter((u) => u.status === "HELD" && u.holdUntil && u.holdUntil.getTime() > now.getTime());
  if (live.length !== units.length) return null; // expired, released, or taken over

  const location = await collections.locations(db).findOne({ _id: units[0]!.locationId });
  return {
    holdUntil: live.reduce<Date>((min, u) => (u.holdUntil! < min ? u.holdUntil! : min), live[0]!.holdUntil!),
    locationId: units[0]!.locationId.toHexString(),
    locationName: location?.name ?? "",
    date: units[0]!.date,
    startMin: units[0]!.startMin,
    endMin: units[units.length - 1]!.endMin,
    amount: units.reduce((sum, u) => sum + u.price, 0),
    breakdown: units.map((u) => ({ startMin: u.startMin, endMin: u.endMin, price: u.price })),
    submittedBookingReference: null,
  };
}

/** Hand a hold back voluntarily (customer re-picked a slot or left the flow). */
export async function releaseHold(holdToken: string): Promise<void> {
  const db = await getDb();
  await collections.slotUnits(db).updateMany(
    { holdTokenHash: hashHoldToken(holdToken), status: "HELD", bookingId: null },
    { $set: { status: "AVAILABLE", holdTokenHash: null, holdUntil: null, updatedAt: new Date() } },
  );
}

/**
 * Optional housekeeping. Availability is already correct without it; this only
 * keeps the collection tidy.
 */
export async function cleanupExpiredHolds(now: Date = new Date()): Promise<number> {
  const db = await getDb();
  const result = await collections.slotUnits(db).updateMany(
    { status: "HELD", holdUntil: { $lte: now }, bookingId: null },
    { $set: { status: "AVAILABLE", holdTokenHash: null, holdUntil: null, updatedAt: now } },
  );
  return result.modifiedCount;
}

/* ──────────────────────────────────────────────────────────────────────────
 * Booking submission
 * ────────────────────────────────────────────────────────────────────── */

export interface SubmitBookingInput {
  holdToken: string;
  customerName: string;
  customerPhone: string;
  paymentScreenshotKey: string;
  now?: Date;
}

/**
 * HELD → PENDING, atomically, with the booking document created in the same
 * transaction. Re-submitting the same hold returns the existing booking instead
 * of creating a second one, which covers double clicks and retried requests.
 */
export async function submitBooking(input: SubmitBookingInput): Promise<BookingDoc> {
  const now = input.now ?? new Date();
  const db = await getDb();
  const holdTokenHash = hashHoldToken(input.holdToken);

  const units = await collections.slotUnits(db).find({ holdTokenHash }).sort({ startMin: 1 }).toArray();
  if (units.length === 0) throw appError("HOLD_INVALID");

  // Idempotency: this hold was already submitted, so return that booking.
  const alreadySubmitted = units.find((u) => u.bookingId);
  if (alreadySubmitted) {
    const existing = await collections.bookings(db).findOne({ _id: alreadySubmitted.bookingId! });
    if (existing) return existing;
  }

  const expired = units.some(
    (u) => u.status !== "HELD" || !u.holdUntil || u.holdUntil.getTime() <= now.getTime(),
  );
  if (expired) throw appError("HOLD_EXPIRED");

  const locationId = units[0]!.locationId;
  const date = units[0]!.date;
  const { location, config, template } = await loadLocationContext(db, locationId, true);

  // Price is recomputed from the server-side schedule; the browser never supplies it.
  const startMin = units[0]!.startMin;
  const endMin = units[units.length - 1]!.endMin;
  const resolved = resolveUnits(template, startMin, endMin);
  if (!resolved || resolved.length !== units.length) {
    log.warn("hold_schedule_drift", { locationId: locationId.toHexString(), date, startMin, endMin });
    throw appError("HOLD_INVALID", "The schedule changed while you were booking. Please select the slot again.");
  }
  assertBookableDate(date, config.bookingWindowDays, now);

  const priceBreakdown = resolved.map((u) => ({ startMin: u.startMin, endMin: u.endMin, price: u.price }));
  const amount = totalPrice(resolved);
  const unitStarts = units.map((u) => u.startMin);

  // Retry only for the (vanishingly rare) reference collision.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const reference = generateBookingReference();
    const bookingId = new ObjectId();
    const booking: BookingDoc = {
      _id: bookingId,
      reference,
      locationId,
      locationName: location.name,
      date,
      startMin,
      endMin,
      unitStarts,
      amount,
      priceBreakdown,
      customerName: input.customerName,
      customerPhone: input.customerPhone,
      status: "PENDING",
      paymentVerificationStatus: "PENDING",
      payments: [
        {
          id: crypto.randomUUID(),
          screenshotKey: input.paymentScreenshotKey,
          uploadedAt: now,
          amount: null,
          status: "PENDING",
          reviewedBy: null,
          reviewedAt: null,
          note: null,
        },
      ],
      amountPaid: 0,
      paymentScreenshotKey: input.paymentScreenshotKey,
      paymentUploadedAt: now,
      rejectionReason: null,
      holdTokenHash,
      timeline: [
        { event: "BOOKING_SUBMITTED", at: now, by: "customer" },
        { event: "PAYMENT_SCREENSHOT_UPLOADED", at: now, by: "customer" },
      ],
      createdAt: now,
      updatedAt: now,
    };

    try {
      await withTransaction(async (session, txDb) => {
        const dayBlock = await collections.dayBlocks(txDb).findOne({ locationId, date }, { session });
        if (dayBlock) throw appError("DAY_BLOCKED");

        // Re-assert ownership inside the transaction: the hold must still be ours,
        // still HELD, and still unexpired at commit time.
        const claim = await collections.slotUnits(txDb).updateMany(
          { holdTokenHash, status: "HELD", holdUntil: { $gt: now }, bookingId: null },
          { $set: { status: "PENDING", bookingId, holdUntil: null, updatedAt: now } },
          { session },
        );
        if (claim.modifiedCount !== units.length) throw appError("HOLD_EXPIRED");

        await collections.bookings(txDb).insertOne(booking, { session });
      });

      log.info("booking_submitted", { reference, locationId: locationId.toHexString(), date, startMin, endMin, amount });
      return booking;
    } catch (err) {
      if (isDuplicateKeyError(err) && attempt < 4) continue; // reference collision — try another

      // Two requests submitted this hold at the same moment (a double click on a
      // slow connection). One transaction claimed the units; this one found
      // nothing left to claim. Hand back the booking that did get created rather
      // than telling the customer their hold expired.
      const raced = await collections.bookings(db).findOne({ holdTokenHash });
      if (raced) return raced;

      rethrowBookingError(err, "booking_submit", { locationId: locationId.toHexString(), date, startMin, endMin });
    }
  }

  throw appError("INTERNAL", "Unable to process your booking right now. Please try again.");
}

/* ──────────────────────────────────────────────────────────────────────────
 * Admin transitions
 * ────────────────────────────────────────────────────────────────────── */

function timelineEntry(event: string, by: string, note?: string): BookingTimelineEntry {
  return note ? { event, at: new Date(), by, note } : { event, at: new Date(), by };
}

/**
 * Record an admin's verdict on ONE payment screenshot, and recompute the booking's
 * payment position from every attempt.
 *
 * Written as an aggregation-pipeline update so the whole thing — mark the attempt,
 * re-total the accepted amounts, re-derive the payment status — happens in a single
 * atomic document update. Two admins reviewing at once cannot interleave into a
 * wrong total, and the filter refuses an attempt that was already reviewed.
 *
 * Crucially this NEVER touches the slot reservations. A payment problem is
 * recoverable; only an explicit rejection gives the slots back.
 */
/**
 * The two pipeline stages that turn a list of payment attempts into a booking's
 * money position. Shared by every path that touches payments so the arithmetic and
 * the status rules have exactly one definition — an admin recording a payment by
 * hand must land in the same place as one read off a screenshot.
 */
function paymentRollupStages(now: Date) {
  return [
    {
      $set: {
        amountPaid: {
          $sum: {
            $map: {
              input: { $ifNull: ["$payments", []] },
              as: "p",
              in: {
                $cond: [{ $eq: ["$$p.status", "ACCEPTED"] }, { $ifNull: ["$$p.amount", 0] }, 0],
              },
            },
          },
        },
      },
    },
    {
      $set: {
        paymentVerificationStatus: {
          $switch: {
            branches: [
              { case: { $gte: ["$amountPaid", "$amount"] }, then: "VERIFIED" },
              { case: { $gt: ["$amountPaid", 0] }, then: "PARTIAL" },
              {
                // Everything sent so far was turned down and nothing is banked.
                case: {
                  $and: [
                    { $gt: [{ $size: { $ifNull: ["$payments", []] } }, 0] },
                    {
                      $eq: [
                        {
                          $size: {
                            $filter: {
                              input: { $ifNull: ["$payments", []] },
                              cond: { $ne: ["$$this.status", "REJECTED"] },
                            },
                          },
                        },
                        0,
                      ],
                    },
                  ],
                },
                then: "REJECTED",
              },
            ],
            default: "PENDING",
          },
        },
        updatedAt: now,
      },
    },
  ];
}

export async function reviewPayment(input: {
  bookingId: ObjectId;
  attemptId: string;
  accepted: boolean;
  /** Rupees the admin actually read on the screenshot. Required when accepting. */
  amount?: number;
  note?: string;
  admin: { username: string };
}): Promise<BookingDoc> {
  const db = await getDb();
  const now = new Date();

  if (input.accepted && (!Number.isFinite(input.amount) || (input.amount ?? 0) <= 0)) {
    throw appError("VALIDATION", "Enter the amount shown on the payment screenshot.");
  }

  const entry = {
    event: input.accepted ? "PAYMENT_ACCEPTED" : "PAYMENT_REJECTED",
    at: now,
    by: input.admin.username,
    ...(input.note ? { note: input.note } : {}),
  };

  const updated = await collections.bookings(db).findOneAndUpdate(
    {
      _id: input.bookingId,
      status: "PENDING",
      payments: { $elemMatch: { id: input.attemptId, status: "PENDING" } },
    },
    [
      {
        $set: {
          payments: {
            $map: {
              input: { $ifNull: ["$payments", []] },
              as: "p",
              in: {
                $cond: [
                  { $eq: ["$$p.id", input.attemptId] },
                  {
                    $mergeObjects: [
                      "$$p",
                      {
                        status: input.accepted ? "ACCEPTED" : "REJECTED",
                        amount: input.accepted ? input.amount : null,
                        reviewedBy: input.admin.username,
                        reviewedAt: now,
                        note: input.note ?? null,
                      },
                    ],
                  },
                  "$$p",
                ],
              },
            },
          },
          timeline: { $concatArrays: [{ $ifNull: ["$timeline", []] }, [entry]] },
        },
      },
      ...paymentRollupStages(now),
    ],
    { returnDocument: "after" },
  );

  if (!updated) {
    throw appError("CONFLICT", "That payment has already been reviewed, or the booking is no longer pending.");
  }

  log.info("payment_reviewed", {
    reference: updated.reference,
    accepted: input.accepted,
    amountPaid: updated.amountPaid,
    expected: updated.amount,
    paymentStatus: updated.paymentVerificationStatus,
  });
  return updated;
}

/**
 * Record money the admin has confirmed themselves, with no screenshot behind it.
 *
 * Real customers send the balance on WhatsApp, or pay in cash at the gate, or send
 * a screenshot from a phone that is not the one they booked on. Without this the
 * booking dead-ends: once every screenshot has been reviewed, the only remaining
 * action is to reject the customer and release slots they have actually paid for.
 *
 * The attempt is stored like any other so the audit trail shows who recorded it and
 * why, and the totals run through the same rollup as a reviewed screenshot.
 */
export async function recordManualPayment(input: {
  bookingId: ObjectId;
  amount: number;
  note: string;
  admin: { username: string };
}): Promise<BookingDoc> {
  const db = await getDb();
  const now = new Date();

  if (!Number.isFinite(input.amount) || input.amount <= 0) {
    throw appError("VALIDATION", "Enter the amount you received.");
  }

  const attempt: PaymentAttempt = {
    id: crypto.randomUUID(),
    screenshotKey: null,
    uploadedAt: now,
    amount: input.amount,
    status: "ACCEPTED",
    reviewedBy: input.admin.username,
    reviewedAt: now,
    note: input.note,
  };

  const updated = await collections.bookings(db).findOneAndUpdate(
    {
      _id: input.bookingId,
      status: "PENDING",
      // Same spam ceiling as customer uploads.
      $expr: { $lt: [{ $size: { $ifNull: ["$payments", []] } }, 10] },
    },
    [
      {
        $set: {
          payments: { $concatArrays: [{ $ifNull: ["$payments", []] }, [{ $literal: attempt }]] },
          timeline: {
            $concatArrays: [
              { $ifNull: ["$timeline", []] },
              [{ $literal: { event: "PAYMENT_RECORDED_BY_STAFF", at: now, by: input.admin.username, note: input.note } }],
            ],
          },
        },
      },
      ...paymentRollupStages(now),
    ],
    { returnDocument: "after" },
  );

  if (!updated) {
    throw appError("CONFLICT", "This booking is not waiting for a payment right now.");
  }

  log.info("payment_recorded_by_staff", {
    reference: updated.reference,
    recorded: input.amount,
    amountPaid: updated.amountPaid,
    expected: updated.amount,
    paymentStatus: updated.paymentVerificationStatus,
    admin: input.admin.username,
  });
  return updated;
}

/**
 * Attach another screenshot to a booking that still owes money. The slots are
 * already reserved and stay that way; this only adds evidence for the admin.
 */
export async function addPaymentAttempt(input: {
  bookingId: ObjectId;
  screenshotKey: string;
  now?: Date;
}): Promise<BookingDoc> {
  const db = await getDb();
  const now = input.now ?? new Date();
  const attempt: PaymentAttempt = {
    id: crypto.randomUUID(),
    screenshotKey: input.screenshotKey,
    uploadedAt: now,
    amount: null,
    status: "PENDING",
    reviewedBy: null,
    reviewedAt: null,
    note: null,
  };

  const updated = await collections.bookings(db).findOneAndUpdate(
    {
      _id: input.bookingId,
      status: "PENDING",
      // Only a booking that is short or was turned down may take more evidence.
      paymentVerificationStatus: { $in: ["PENDING", "PARTIAL", "REJECTED"] },
      // A cheap guard against someone spamming the admin's queue. $ifNull because
      // $size raises on a missing field, and bookings taken before payment
      // attempts existed have no array at all.
      $expr: { $lt: [{ $size: { $ifNull: ["$payments", []] } }, 10] },
    },
    [
      {
        $set: {
          payments: { $concatArrays: [{ $ifNull: ["$payments", []] }, [{ $literal: attempt }]] },
          timeline: {
            $concatArrays: [
              { $ifNull: ["$timeline", []] },
              [{ $literal: timelineEntry("PAYMENT_SCREENSHOT_UPLOADED", "customer") }],
            ],
          },
          paymentScreenshotKey: input.screenshotKey,
          paymentUploadedAt: now,
          updatedAt: now,
          /**
           * A booking whose screenshots were all turned down is back to "waiting
           * for review" the moment the customer sends another one. Without this it
           * would keep a REJECTED payment badge while a real payment sat unread,
           * and an admin filtering for unverified payments would never see it.
           * PARTIAL is left alone: money genuinely did arrive.
           */
          paymentVerificationStatus: {
            $cond: [{ $eq: ["$paymentVerificationStatus", "REJECTED"] }, "PENDING", "$paymentVerificationStatus"],
          },
        },
      },
    ],
    { returnDocument: "after" },
  );

  if (!updated) {
    throw appError("CONFLICT", "This booking is not waiting for a payment right now.");
  }

  log.info("payment_attempt_added", { reference: updated.reference, attempts: updated.payments.length });
  return updated;
}

/**
 * PENDING → CONFIRMED with the owned units moving PENDING → BOOKED in the same
 * transaction. Re-checks ownership so a stale admin tab cannot confirm a booking
 * whose units have already moved on.
 */
export async function confirmBooking(bookingId: ObjectId, admin: { username: string }): Promise<BookingDoc> {
  const now = new Date();

  return withTransaction(async (session, txDb) => {
    const booking = await collections.bookings(txDb).findOne({ _id: bookingId }, { session });
    if (!booking) throw appError("NOT_FOUND", "That booking no longer exists.");
    if (booking.status === "CONFIRMED") return booking; // idempotent
    if (booking.status !== "PENDING") {
      throw appError("CONFLICT", `This booking is ${booking.status.toLowerCase()} and can no longer be confirmed.`);
    }
    const paid = booking.amountPaid ?? 0;
    if (booking.paymentVerificationStatus !== "VERIFIED" || paid < booking.amount) {
      const short = booking.amount - paid;
      throw appError(
        "CONFLICT",
        short > 0
          ? `₹${short.toLocaleString("en-IN")} is still outstanding. Record the balance payment before confirming.`
          : "Verify the payment before confirming this booking.",
      );
    }

    const claim = await collections.slotUnits(txDb).updateMany(
      { bookingId, status: "PENDING" },
      { $set: { status: "BOOKED", holdTokenHash: null, holdUntil: null, updatedAt: now } },
      { session },
    );
    if (claim.modifiedCount !== booking.unitStarts.length) {
      throw appError("CONFLICT", "These slots are no longer reserved for this booking. Please refresh and review.");
    }

    const updated = await collections.bookings(txDb).findOneAndUpdate(
      { _id: bookingId, status: "PENDING" },
      {
        $set: { status: "CONFIRMED", updatedAt: now },
        $push: { timeline: timelineEntry("BOOKING_CONFIRMED", admin.username) },
      },
      { session, returnDocument: "after" },
    );
    if (!updated) throw appError("CONFLICT", "This booking changed while you were reviewing it. Please refresh.");

    log.info("booking_confirmed", { reference: updated.reference, admin: admin.username });
    return updated;
  });
}

/**
 * PENDING → REJECTED and the units go back to AVAILABLE.
 *
 * Only units this booking actually owns are released, and BLOCKED units are
 * never touched: rejecting a customer must not reopen turf the admin closed.
 */
export async function rejectBooking(
  bookingId: ObjectId,
  reason: string,
  admin: { username: string },
): Promise<BookingDoc> {
  const now = new Date();

  return withTransaction(async (session, txDb) => {
    const booking = await collections.bookings(txDb).findOne({ _id: bookingId }, { session });
    if (!booking) throw appError("NOT_FOUND", "That booking no longer exists.");
    if (booking.status === "REJECTED") return booking; // idempotent
    if (booking.status !== "PENDING") {
      throw appError("CONFLICT", `This booking is ${booking.status.toLowerCase()} and can no longer be rejected.`);
    }

    await collections.slotUnits(txDb).updateMany(
      { bookingId, status: { $in: ["PENDING", "HELD"] } },
      {
        $set: {
          status: "AVAILABLE",
          holdTokenHash: null,
          holdUntil: null,
          bookingId: null,
          updatedAt: now,
        },
      },
      { session },
    );

    const updated = await collections.bookings(txDb).findOneAndUpdate(
      { _id: bookingId, status: "PENDING" },
      {
        $set: {
          status: "REJECTED",
          rejectionReason: reason,
          // A payment the admin already verified stays VERIFIED: rejecting the
          // booking for another reason must not erase the record that money
          // actually arrived and may be owed back.
          ...(booking.paymentVerificationStatus === "PENDING"
            ? { paymentVerificationStatus: "REJECTED" as const }
            : {}),
          updatedAt: now,
        },
        $push: { timeline: timelineEntry("BOOKING_REJECTED", admin.username, reason) },
      },
      { session, returnDocument: "after" },
    );
    if (!updated) throw appError("CONFLICT", "This booking changed while you were reviewing it. Please refresh.");

    log.info("booking_rejected", { reference: updated.reference, admin: admin.username });
    return updated;
  });
}

export async function recordWhatsappOpened(
  bookingId: ObjectId,
  kind: "CONFIRM" | "REJECT" | "BALANCE",
  admin: { username: string },
): Promise<void> {
  const db = await getDb();
  await collections.bookings(db).updateOne(
    { _id: bookingId },
    {
      // "Opened", never "sent" — the admin still has to press send in WhatsApp.
      $push: { timeline: timelineEntry(`WHATSAPP_${kind}_OPENED`, admin.username) },
    },
  );
}

/* ──────────────────────────────────────────────────────────────────────────
 * Blocking
 * ────────────────────────────────────────────────────────────────────── */

export interface BlockConflict {
  startMin: number;
  endMin: number;
  status: SlotUnitDoc["status"];
  bookingReference: string | null;
  customerName: string | null;
}

/** Live holds, pending requests and confirmed bookings that a block would tread on. */
export async function findBlockConflicts(
  locationId: ObjectId,
  date: string,
  startMin: number,
  endMin: number,
  now: Date = new Date(),
): Promise<BlockConflict[]> {
  const db = await getDb();
  const units = await collections
    .slotUnits(db)
    .find({ locationId, date, startMin: { $gte: startMin, $lt: endMin } })
    .sort({ startMin: 1 })
    .toArray();

  const occupied = units.filter((u) => liveStatus(u, now) !== "AVAILABLE" && u.status !== "BLOCKED");
  if (occupied.length === 0) return [];

  const bookingIds = occupied.map((u) => u.bookingId).filter((id): id is ObjectId => Boolean(id));
  const bookings = bookingIds.length
    ? await collections.bookings(db).find({ _id: { $in: bookingIds } }).toArray()
    : [];
  const byId = new Map(bookings.map((b) => [b._id.toHexString(), b]));

  return occupied.map((u) => {
    const booking = u.bookingId ? byId.get(u.bookingId.toHexString()) : undefined;
    return {
      startMin: u.startMin,
      endMin: u.endMin,
      status: u.status,
      bookingReference: booking?.reference ?? null,
      customerName: booking?.customerName ?? null,
    };
  });
}

export interface BlockOutcome {
  blocked: number;
  conflicts: BlockConflict[];
}

/**
 * Block a time range. Refuses when the range contains live holds, pending
 * requests or confirmed bookings unless the admin explicitly forces it, and
 * a CONFIRMED booking can never be blocked over at all.
 */
export async function blockSlots(input: {
  locationId: ObjectId;
  date: string;
  startMin: number;
  endMin: number;
  reason: string;
  force: boolean;
  admin: { username: string };
  now?: Date;
}): Promise<BlockOutcome> {
  const now = input.now ?? new Date();
  assertNotPast(input.date, now);
  const db = await getDb();
  const { template } = await loadLocationContext(db, input.locationId, false);

  const conflicts = await findBlockConflicts(input.locationId, input.date, input.startMin, input.endMin, now);
  const confirmed = conflicts.filter((c) => c.status === "BOOKED");
  if (confirmed.length > 0) {
    throw appError(
      "CONFLICT",
      "This period contains confirmed bookings. Cancel or move those bookings before blocking it.",
      { conflicts },
    );
  }
  if (conflicts.length > 0 && !input.force) {
    return { blocked: 0, conflicts };
  }

  const targets = template.filter((u) => u.startMin >= input.startMin && u.endMin <= input.endMin);
  if (targets.length === 0) throw appError("VALIDATION", "That range does not contain any bookable slots.");

  let blocked = 0;
  try {
    await withTransaction(async (session, txDb) => {
      for (const unit of targets) {
        const result = await collections.slotUnits(txDb).updateOne(
          { locationId: input.locationId, date: input.date, startMin: unit.startMin, status: { $ne: "BOOKED" } },
          {
            $set: {
              endMin: unit.endMin,
              status: "BLOCKED",
              holdTokenHash: null,
              holdUntil: null,
              bookingId: null,
              price: unit.price,
              blockReason: input.reason,
              blockedBy: input.admin.username,
              blockedAt: now,
              updatedAt: now,
            },
            $setOnInsert: { createdAt: now },
          },
          { upsert: true, session },
        );
        blocked += result.modifiedCount + result.upsertedCount;
      }

      // A pending request whose slots were just taken away is rejected explicitly,
      // so a customer's record never silently loses the slots it owned.
      if (input.force) {
        const affected = [
          ...new Set(conflicts.map((c) => c.bookingReference).filter((r): r is string => Boolean(r))),
        ];
        if (affected.length > 0) {
          const disrupted = await collections
            .bookings(txDb)
            .find({ reference: { $in: affected }, status: "PENDING" }, { session, projection: { _id: 1 } })
            .toArray();
          const ids = disrupted.map((b) => b._id);

          if (ids.length > 0) {
            await collections.bookings(txDb).updateMany(
              { _id: { $in: ids } },
              {
                $set: {
                  status: "REJECTED",
                  rejectionReason: `Slot blocked by the turf: ${input.reason}`,
                  updatedAt: now,
                },
                $push: { timeline: timelineEntry("BOOKING_REJECTED", input.admin.username, `Blocked: ${input.reason}`) },
              },
              { session },
            );

            // A booking can straddle the block: block 7-8 of a 7-9 booking and the
            // 8-9 hour is left reserved for a booking that no longer exists, so it
            // could never be sold again. Rejecting the booking must hand back every
            // hour it still owns. The hours inside the block are already BLOCKED by
            // the loop above, so this only touches the ones outside it.
            await collections.slotUnits(txDb).updateMany(
              { bookingId: { $in: ids }, status: { $in: ["PENDING", "HELD"] } },
              {
                $set: {
                  status: "AVAILABLE",
                  holdTokenHash: null,
                  holdUntil: null,
                  bookingId: null,
                  updatedAt: now,
                },
              },
              { session },
            );
          }
        }
      }
    });
  } catch (err) {
    if (err instanceof AppError) throw err;
    if (isDuplicateKeyError(err)) {
      // A booking was confirmed between the conflict scan and the write.
      throw appError("CONFLICT", "These slots changed while you were blocking them. Please refresh and try again.");
    }
    log.error("block_slots_failed", { err, locationId: input.locationId.toHexString(), date: input.date });
    throw appError("INTERNAL", "Unable to block those slots right now. Please try again.");
  }

  log.info("slots_blocked", {
    locationId: input.locationId.toHexString(),
    date: input.date,
    startMin: input.startMin,
    endMin: input.endMin,
    blocked,
    forced: input.force,
  });
  return { blocked, conflicts: input.force ? conflicts : [] };
}

export async function unblockSlots(input: {
  locationId: ObjectId;
  date: string;
  startMin: number;
  endMin: number;
}): Promise<number> {
  const db = await getDb();
  const result = await collections.slotUnits(db).updateMany(
    {
      locationId: input.locationId,
      date: input.date,
      startMin: { $gte: input.startMin, $lt: input.endMin },
      status: "BLOCKED",
    },
    {
      $set: {
        status: "AVAILABLE",
        blockReason: null,
        blockedBy: null,
        blockedAt: null,
        updatedAt: new Date(),
      },
    },
  );
  return result.modifiedCount;
}

/**
 * Close a whole location for a date with ONE document rather than materialising
 * every slot. The availability query consults it, so it cannot be bypassed.
 */
export async function blockDay(input: {
  locationId: ObjectId;
  date: string;
  reason: string;
  force: boolean;
  admin: { username: string };
  now?: Date;
}): Promise<BlockOutcome> {
  const now = input.now ?? new Date();
  assertNotPast(input.date, now);
  const db = await getDb();
  const { config } = await loadLocationContext(db, input.locationId, false);

  const conflicts = await findBlockConflicts(input.locationId, input.date, config.openMin, config.closeMin, now);
  const confirmed = conflicts.filter((c) => c.status === "BOOKED");
  if (confirmed.length > 0) {
    throw appError(
      "CONFLICT",
      "This day contains confirmed bookings. Cancel or move those bookings before blocking the day.",
      { conflicts },
    );
  }
  if (conflicts.length > 0 && !input.force) return { blocked: 0, conflicts };

  await collections.dayBlocks(db).updateOne(
    { locationId: input.locationId, date: input.date },
    {
      $set: { reason: input.reason, blockedBy: input.admin.username, blockedAt: now },
      $setOnInsert: { locationId: input.locationId, date: input.date },
    },
    { upsert: true },
  );

  if (input.force) {
    const affected = conflicts.filter((c) => c.bookingReference).map((c) => c.bookingReference!);
    if (affected.length > 0) {
      await collections.bookings(db).updateMany(
        { reference: { $in: affected }, status: "PENDING" },
        {
          $set: { status: "REJECTED", rejectionReason: `Day blocked: ${input.reason}`, updatedAt: now },
          $push: { timeline: timelineEntry("BOOKING_REJECTED", input.admin.username, `Day blocked: ${input.reason}`) },
        },
      );
    }
    await collections.slotUnits(db).updateMany(
      { locationId: input.locationId, date: input.date, status: { $in: ["HELD", "PENDING"] } },
      {
        $set: {
          status: "AVAILABLE",
          holdTokenHash: null,
          holdUntil: null,
          bookingId: null,
          updatedAt: now,
        },
      },
    );
  }

  log.info("day_blocked", { locationId: input.locationId.toHexString(), date: input.date, forced: input.force });
  return { blocked: 1, conflicts: input.force ? conflicts : [] };
}

export async function unblockDay(locationId: ObjectId, date: string): Promise<boolean> {
  const db = await getDb();
  const result = await collections.dayBlocks(db).deleteOne({ locationId, date });
  return result.deletedCount > 0;
}
