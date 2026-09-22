import "server-only";
import crypto from "node:crypto";
import { ObjectId, type ClientSession, type Db } from "mongodb";
import { collections, getDb, getMongoClient, isDuplicateKeyError } from "@/lib/db";
import { appError, AppError } from "@/lib/errors";
import { log } from "@/lib/log";
import { deletePaymentScreenshot, listStoredScreenshots, type StoredScreenshot } from "@/lib/storage";
import { daysFromToday, istDateString, istInstant, isValidBusinessDate } from "@/lib/time";
import type {
  BallType,
  BookingDoc,
  BookingTimelineEntry,
  FacilityConfig,
  FacilityDoc,
  FacilityKind,
  PaymentAttempt,
  LocationDoc,
  PublicSlotStatus,
  ResourceDoc,
  SlotUnitDoc,
} from "@/lib/types";
import {
  advanceFor,
  applyBallPricing,
  buildDayTemplate,
  findBallType,
  isPastSlot,
  isWeekendRate,
  oversLadder,
  resolveUnits,
  slotsForOvers,
  totalPrice,
  type SlotUnitTemplate,
} from "./schedule";

// Re-exported because both are part of this module's public surface as far as the
// routes are concerned; they live in schedule.ts because they are pure arithmetic
// and importing this file drags in the database driver.
export { advanceFor, isPastSlot };
import { generateBookingReference, generateHoldToken, hashHoldToken } from "./reference";

/**
 * How long a slot is held while the customer pays.
 *
 * Five minutes, not ten: the owner would rather a hesitant customer lose the
 * hold and re-pick than have a ready buyer told the slot is taken by someone who
 * wandered off. UPI payment plus a screenshot takes a minute or two in practice.
 */
export const DEFAULT_HOLD_MINUTES = 5;

/** Starting point for a new hourly facility — box cricket, nets, a court. */
export const DEFAULT_HOURLY_CONFIG: FacilityConfig = {
  slotMinutes: 60,
  openMin: 6 * 60,
  closeMin: 23 * 60,
  bookingWindowDays: 30,
  holdMinutes: DEFAULT_HOLD_MINUTES,
  priceRules: [
    { fromMin: 6 * 60, toMin: 17 * 60, price: 800 },
    { fromMin: 17 * 60, toMin: 23 * 60, price: 1200 },
  ],
  // Empty until the owner sets weekend prices, which means one price all week.
  weekendPriceRules: [],
  weekendDays: [5, 6, 0],
  oversPerSlot: 0,
  payAtVenueMaxOvers: 0,
  // Full amount up front until the owner says otherwise.
  advancePercent: 0,
  ballTypes: [],
};

/**
 * Starting point for a new bowling machine.
 *
 * These are the owner's current rules, not laws: every number is editable in
 * Admin → Locations, and the code reads them from the facility rather than here.
 */
export const DEFAULT_OVERS_CONFIG: FacilityConfig = {
  slotMinutes: 15,
  openMin: 6 * 60,
  closeMin: 23 * 60,
  bookingWindowDays: 30,
  holdMinutes: DEFAULT_HOLD_MINUTES,
  // Price 0 across the window: the ball type carries the price, and this rule
  // exists only to mark the hours as sellable.
  priceRules: [{ fromMin: 6 * 60, toMin: 23 * 60, price: 0 }],
  // A bowling session is priced by its ball, so there is no weekday/weekend table.
  weekendPriceRules: [],
  weekendDays: [5, 6, 0],
  oversPerSlot: 10,
  payAtVenueMaxOvers: 40,
  advancePercent: 0,
  ballTypes: [
    { id: "synthetic", name: "Synthetic ball", pricePerSlot: 180 },
    { id: "leather", name: "Leather ball", pricePerSlot: 100 },
  ],
};

export function defaultConfigFor(kind: FacilityKind): FacilityConfig {
  return kind === "OVERS"
    ? { ...DEFAULT_OVERS_CONFIG, ballTypes: DEFAULT_OVERS_CONFIG.ballTypes.map((b) => ({ ...b })) }
    : { ...DEFAULT_HOURLY_CONFIG, priceRules: DEFAULT_HOURLY_CONFIG.priceRules.map((r) => ({ ...r })) };
}

/**
 * Whether a session this size is confirmed on the spot and paid for at the ground.
 *
 * Decided here, from stored configuration and the overs the SERVER resolved, so a
 * client cannot declare its own booking free by claiming to be small.
 */
export function isPayAtVenue(config: FacilityConfig, overs: number | null): boolean {
  return overs !== null && config.payAtVenueMaxOvers > 0 && overs <= config.payAtVenueMaxOvers;
}

/* ──────────────────────────────────────────────────────────────────────────
 * Context loading
 * ────────────────────────────────────────────────────────────────────── */

export interface ResourceContext {
  location: LocationDoc;
  facility: FacilityDoc;
  resource: ResourceDoc;
  config: FacilityConfig;
  /** The weekday shape of the day. For anything that takes money, use {@link templateFor}. */
  template: SlotUnitTemplate[];
  /**
   * The day as it is actually priced on a given date.
   *
   * Separate from `template` because a ground can charge more at the weekend, so
   * a price is only correct once the date is known. Every path that quotes, holds
   * or charges goes through this; the plain template is for shape alone.
   */
  templateFor: (date?: string) => SlotUnitTemplate[];
}

/**
 * Everything needed to price and reserve time on one bookable resource.
 *
 * Walks resource → facility → location rather than the other way round, because
 * the resource id is what every slot unit is keyed on: if it resolves, the rest
 * of the chain is guaranteed to exist and to agree with it.
 */
/**
 * The ground, the service and the court behind one resource, briefly remembered.
 *
 * Every availability check, every hold and every submission needs these three
 * documents, and they are among the least changeable things in the system — the
 * owner edits a price a few times a year. Re-reading them on every request cost
 * two round trips each: measured at a hundred people booking at once, that was
 * several seconds per hold spent fetching rows that had not changed since the
 * previous customer asked for them.
 *
 * Fifteen seconds is deliberately short. A price or an opening hour edited in the
 * admin panel is live within that, deactivating a ground stops sales within that,
 * and the window is smaller than the five-minute hold a customer already gets —
 * so it introduces no staleness the booking flow did not already have.
 */
const CONTEXT_TTL_MS = 15_000;

interface CachedContext {
  resource: ResourceDoc;
  facility: FacilityDoc;
  location: LocationDoc;
  expiresAt: number;
}

const contextCache = new Map<string, CachedContext>();

/**
 * Forget what was remembered about a resource, or about everything.
 *
 * Called by the admin routes that change any of it, so an owner watching their
 * own edit does not have to wait out the TTL to see it. On a deployment with
 * several instances only the one that took the write clears early; the rest
 * expire on their own, which is what the short TTL is for.
 */
export function forgetResourceContext(resourceId?: ObjectId): void {
  if (resourceId) contextCache.delete(resourceId.toHexString());
  else contextCache.clear();
}

export async function loadResourceContext(
  db: Db,
  resourceId: ObjectId,
  requireActive: boolean,
): Promise<ResourceContext> {
  const key = resourceId.toHexString();
  const now = Date.now();
  let cached = contextCache.get(key);

  if (!cached || cached.expiresAt <= now) {
    const resource = await collections.resources(db).findOne({ _id: resourceId });
    if (!resource) throw appError("NOT_FOUND", "We could not find that court or pitch.");

    const [facility, location] = await Promise.all([
      collections.facilities(db).findOne({ _id: resource.facilityId }),
      collections.locations(db).findOne({ _id: resource.locationId }),
    ]);
    if (!facility) throw appError("NOT_FOUND", "We could not find that facility.");
    if (!location) throw appError("NOT_FOUND", "We could not find that location.");

    cached = { resource, facility, location, expiresAt: now + CONTEXT_TTL_MS };
    contextCache.set(key, cached);
  }

  const { resource, facility, location } = cached;

  // Checked on every call, cached or not: this is the switch that takes a ground
  // off sale, and it must not be answered from a copy older than the check.
  if (requireActive && (!location.active || !facility.active || !resource.active)) {
    throw appError("LOCATION_INACTIVE");
  }

  const config = facility.config;
  return {
    location,
    facility,
    resource,
    config,
    template: buildDayTemplate(config),
    templateFor: (date?: string) => buildDayTemplate(config, date),
  };
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
  /** True when this date is charged at the ground's weekend rates. */
  weekendRate?: boolean;
  resourceId: string;
  resourceName: string;
  facilityId: string;
  facilityName: string;
  facilityKind: FacilityKind;
  locationId: string;
  locationName: string;
  date: string;
  slotMinutes: number;
  holdMinutes: number;
  dayBlocked: boolean;
  units: AvailabilityUnit[];
  /**
   * OVERS facilities only. Sent with availability rather than fetched separately
   * so the overs a customer is offered and the units behind them come from one
   * consistent read of the schedule.
   */
  oversPerSlot: number;
  /** Quick-pick overs, longest first limited by how much of the day one can fill. */
  oversLadder: number[];
  /** At or below this many overs, no online payment is asked for. 0 = always pay. */
  payAtVenueMaxOvers: number;
  ballTypes: Array<{ id: string; name: string; pricePerSlot: number }>;
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
  resourceId: ObjectId,
  date: string,
  now: Date = new Date(),
): Promise<AvailabilityResult> {
  const db = await getDb();
  const { location, facility, resource, config, templateFor } = await loadResourceContext(db, resourceId, true);
  assertBookableDate(date, config.bookingWindowDays, now);
  const template = templateFor(date);

  const [stored, dayBlock] = await Promise.all([
    collections.slotUnits(db).find({ resourceId, date }).toArray(),
    collections.dayBlocks(db).findOne({ resourceId, date }),
  ]);

  const byStart = new Map(stored.map((u) => [u.startMin, u]));

  const units: AvailabilityUnit[] = template.map((slot) => {
    let status: PublicSlotStatus = dayBlock ? "BLOCKED" : liveStatus(byStart.get(slot.startMin), now);
    // A slot whose start time has already passed is never bookable, including today.
    if (status === "AVAILABLE" && isPastSlot(date, slot.startMin, now)) status = "PAST";
    return { startMin: slot.startMin, endMin: slot.endMin, price: slot.price, status };
  });

  const isOvers = facility.kind === "OVERS";

  return {
    resourceId: resourceId.toHexString(),
    resourceName: resource.name,
    facilityId: facility._id.toHexString(),
    facilityName: facility.name,
    facilityKind: facility.kind,
    locationId: location._id.toHexString(),
    locationName: location.name,
    date,
    slotMinutes: config.slotMinutes,
    holdMinutes: config.holdMinutes,
    dayBlocked: Boolean(dayBlock),
    // Told to the customer rather than left to be noticed in the total: a Saturday
    // evening costing more than a Tuesday one is a price list, not a mistake.
    weekendRate: isWeekendRate(config, date),
    units,
    oversPerSlot: isOvers ? config.oversPerSlot : 0,
    oversLadder: isOvers
      ? oversLadder(config.oversPerSlot, config.slotMinutes, config.openMin, config.closeMin)
      : [],
    payAtVenueMaxOvers: isOvers ? config.payAtVenueMaxOvers : 0,
    ballTypes: isOvers
      ? config.ballTypes.map((b) => ({ id: b.id, name: b.name, pricePerSlot: b.pricePerSlot }))
      : [],
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
  resourceId: string;
  resourceName: string;
  facilityName: string;
  facilityKind: FacilityKind;
  locationId: string;
  locationName: string;
  date: string;
  startMin: number;
  endMin: number;
  overs: number | null;
  ballTypeName: string | null;
  /** True when this session is confirmed on the spot and paid for at the ground. */
  payAtVenue: boolean;
  amount: number;
  /** What may be paid online to hold this, or 0 when the full amount is due. */
  advanceAmount: number;
  breakdown: Array<{ startMin: number; endMin: number; price: number }>;
}

/**
 * What the customer asked for, in whichever language their facility speaks.
 *
 * An hourly facility gets a time range off the grid. An overs facility gets a
 * start time, a number of overs and a ball. Both end up as the same thing — a
 * run of consecutive atomic units with a price each — which is why there is only
 * one hold, one submit and one set of concurrency guarantees below.
 */
export interface BookingRequest {
  startMin: number;
  endMin?: number;
  overs?: number;
  ballTypeId?: string;
}

interface ResolvedRequest {
  startMin: number;
  endMin: number;
  units: SlotUnitTemplate[];
  overs: number | null;
  ballType: BallType | null;
}

/**
 * Turn a request into the exact units it needs and what each of them costs.
 *
 * Every price here is computed from the stored configuration. Nothing a browser
 * sends contributes to an amount — the client picks WHAT to buy, never what it
 * costs. Called again at submission time so a schedule edited mid-booking is
 * caught rather than honoured.
 */
function resolveRequest(ctx: ResourceContext, input: BookingRequest, date: string): ResolvedRequest {
  const { config, facility } = ctx;
  // The date decides which price table applies, so it is resolved here rather
  // than carried in from a template built before anyone knew the day.
  const template = ctx.templateFor(date);

  if (facility.kind === "OVERS") {
    if (config.ballTypes.length === 0 || config.oversPerSlot <= 0) {
      throw appError("VALIDATION", "This facility is not set up for bookings yet. Please call the ground.");
    }

    const overs = input.overs ?? 0;
    // No ceiling: a customer may book as many overs as the day still has room
    // for. The only rule is that overs come in whole blocks, because a fraction
    // of a slot is not a thing the machine can be reserved for.
    const slots = slotsForOvers(config.oversPerSlot, overs);
    if (slots === null) {
      throw appError(
        "VALIDATION",
        `Overs are booked in blocks of ${config.oversPerSlot}. Please choose ${config.oversPerSlot}, ${config.oversPerSlot * 2}, ${config.oversPerSlot * 3} and so on.`,
      );
    }

    const ballType = findBallType(config.ballTypes, input.ballTypeId ?? "");
    if (!ballType) throw appError("VALIDATION", "Please choose a ball type.");

    const endMin = input.startMin + slots * config.slotMinutes;
    const units = resolveUnits(template, input.startMin, endMin);
    if (!units || units.length === 0) {
      // Almost always a session that would run past closing time, so say that
      // rather than "not bookable", which reads as though the machine is broken.
      throw appError(
        "VALIDATION",
        `${overs} overs will not fit from that time. Please pick an earlier start or fewer overs.`,
      );
    }

    return {
      startMin: input.startMin,
      endMin,
      units: applyBallPricing(units, ballType),
      overs,
      ballType,
    };
  }

  const endMin = input.endMin ?? 0;
  const units = resolveUnits(template, input.startMin, endMin);
  if (!units || units.length === 0) {
    throw appError("VALIDATION", "That time range is not bookable. Please pick from the listed slots.");
  }
  return { startMin: input.startMin, endMin, units, overs: null, ballType: null };
}

/**
 * Atomically reserve every atomic unit in [startMin, endMin) for `holdMinutes`.
 *
 * Why this is safe under concurrency:
 *  1. `slotUnits` carries a UNIQUE index on (resourceId, date, startMin), so at
 *     most one document can ever exist for a unit.
 *  2. Each unit is claimed by a conditional upsert whose filter matches only a
 *     free unit (absent, AVAILABLE, or an expired HELD). When the unit is really
 *     taken the filter misses, the upsert falls through to an insert, and the
 *     unique index rejects it with E11000 — the database refuses the double
 *     booking, not application code.
 *  3. Every unit is claimed inside one transaction, so a multi-unit request is
 *     all-or-nothing: a conflict on the last of a 40-over session's four
 *     quarter-hours rolls the first three back. Nothing is ever half reserved.
 */
export async function createHold(
  input: BookingRequest & {
    resourceId: ObjectId;
    date: string;
    now?: Date;
    /**
     * Staff only: ignore how far ahead CUSTOMERS may book.
     *
     * The window is a rule about the website, not about the ground. When a regular
     * rings up for a tournament next month the owner should be able to write it in,
     * and the dates that still cannot be booked — the past, a closed day, a taken
     * slot — are enforced below regardless.
     */
    bypassWindow?: boolean;
  },
): Promise<HoldResult> {
  const now = input.now ?? new Date();
  const db = await getDb();
  const ctx = await loadResourceContext(db, input.resourceId, true);
  const { location, facility, resource, config } = ctx;

  if (input.bypassWindow) assertNotPast(input.date, now);
  else assertBookableDate(input.date, config.bookingWindowDays, now);

  const { startMin, endMin, units, overs, ballType } = resolveRequest(ctx, input, input.date);

  if (istInstant(input.date, startMin).getTime() <= now.getTime()) {
    throw appError("PAST_DATE", "That time has already passed. Please pick an upcoming slot.");
  }

  const holdToken = generateHoldToken();
  const holdTokenHash = hashHoldToken(holdToken);
  const holdUntil = new Date(now.getTime() + config.holdMinutes * 60_000);
  const context = {
    resourceId: input.resourceId.toHexString(),
    date: input.date,
    startMin,
    endMin,
    ...(overs !== null ? { overs } : {}),
  };

  /**
   * Fail fast on a slot that is plainly gone.
   *
   * When a hundred phones open the same 6 PM slot at once only one can win, and
   * letting the other ninety-nine fight it out inside snapshot transactions makes
   * each of them wait seconds for a refusal the database already knows about.
   * This read is advisory only: it never grants anything, and the transaction
   * below with its unique index remains the thing that actually decides. A slot
   * freed between this read and that transaction simply falls through and is won
   * there. BLOCKED is deliberately left out, so "the ground is closed then" keeps
   * coming back with its own wording rather than "somebody beat you to it".
   */
  const alreadyTaken = await collections.slotUnits(db).countDocuments(
    {
      resourceId: input.resourceId,
      date: input.date,
      startMin: { $in: units.map((u) => u.startMin) },
      $or: [{ status: { $in: ["PENDING", "BOOKED"] } }, { status: "HELD", holdUntil: { $gt: now } }],
    },
    { limit: 1 },
  );
  if (alreadyTaken > 0) {
    log.info("hold_conflict_fast", context);
    throw appError("SLOT_CONFLICT");
  }

  try {
    await withTransaction(async (session, txDb) => {
      const dayBlock = await collections
        .dayBlocks(txDb)
        .findOne({ resourceId: input.resourceId, date: input.date }, { session });
      if (dayBlock) throw appError("DAY_BLOCKED");

      for (const unit of units) {
        await collections.slotUnits(txDb).updateOne(
          {
            resourceId: input.resourceId,
            date: input.date,
            startMin: unit.startMin,
            $or: [{ status: "AVAILABLE" }, { status: "HELD", holdUntil: { $lte: now } }],
          },
          {
            $set: {
              locationId: resource.locationId,
              facilityId: resource.facilityId,
              endMin: unit.endMin,
              status: "HELD",
              holdTokenHash,
              holdUntil,
              bookingId: null,
              price: unit.price,
              ballTypeId: ballType?.id ?? null,
              overs,
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
        resourceId: input.resourceId,
        date: input.date,
        startMin: { $gte: startMin, $lt: endMin },
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
    resourceId: resource._id.toHexString(),
    resourceName: resource.name,
    facilityName: facility.name,
    facilityKind: facility.kind,
    locationId: location._id.toHexString(),
    locationName: location.name,
    date: input.date,
    startMin,
    endMin,
    overs,
    ballTypeName: ballType?.name ?? null,
    payAtVenue: isPayAtVenue(config, overs),
    amount: totalPrice(units),
    advanceAmount: advanceFor(config, totalPrice(units)),
    breakdown: units.map((u) => ({ startMin: u.startMin, endMin: u.endMin, price: u.price })),
  };
}

export interface HoldSnapshot {
  holdUntil: Date;
  resourceId: string;
  resourceName: string;
  facilityName: string;
  facilityKind: FacilityKind;
  locationId: string;
  locationName: string;
  date: string;
  startMin: number;
  endMin: number;
  overs: number | null;
  ballTypeName: string | null;
  payAtVenue: boolean;
  amount: number;
  advanceAmount: number;
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
        resourceId: booking.resourceId.toHexString(),
        resourceName: booking.resourceName,
        facilityName: booking.facilityName,
        facilityKind: booking.overs === null ? "HOURLY" : "OVERS",
        locationId: booking.locationId.toHexString(),
        locationName: booking.locationName,
        date: booking.date,
        startMin: booking.startMin,
        endMin: booking.endMin,
        overs: booking.overs,
        ballTypeName: booking.ballTypeName,
        payAtVenue: Boolean(booking.payAtVenue),
        amount: booking.amount,
        advanceAmount: booking.amountDueNow && booking.amountDueNow < booking.amount ? booking.amountDueNow : 0,
        breakdown: booking.priceBreakdown,
        submittedBookingReference: booking.reference,
      };
    }
  }

  const live = units.filter((u) => u.status === "HELD" && u.holdUntil && u.holdUntil.getTime() > now.getTime());
  if (live.length !== units.length) return null; // expired, released, or taken over

  const ctx = await loadResourceContext(db, units[0]!.resourceId, false).catch(() => null);
  const ballTypeId = units[0]!.ballTypeId;
  const ballType = ballTypeId && ctx ? findBallType(ctx.config.ballTypes, ballTypeId) : null;
  const startMin = units[0]!.startMin;
  const endMin = units[units.length - 1]!.endMin;
  const overs = units[0]!.overs ?? null;

  return {
    holdUntil: live.reduce<Date>((min, u) => (u.holdUntil! < min ? u.holdUntil! : min), live[0]!.holdUntil!),
    resourceId: units[0]!.resourceId.toHexString(),
    resourceName: ctx?.resource.name ?? "",
    facilityName: ctx?.facility.name ?? "",
    facilityKind: ctx?.facility.kind ?? "HOURLY",
    locationId: units[0]!.locationId.toHexString(),
    locationName: ctx?.location.name ?? "",
    date: units[0]!.date,
    startMin,
    endMin,
    overs,
    ballTypeName: ballType?.name ?? null,
    payAtVenue: ctx ? isPayAtVenue(ctx.config, overs) : false,
    amount: units.reduce((sum, u) => sum + u.price, 0),
    advanceAmount: ctx ? advanceFor(ctx.config, units.reduce((sum, u) => sum + u.price, 0)) : 0,
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
  /**
   * Null for a session small enough to pay for at the ground. Whether that is
   * allowed is decided from stored configuration and the overs on the HOLD, so
   * omitting it cannot itself make a booking free.
   */
  paymentScreenshotKey: string | null;
  /**
   * The 12-digit UPI reference. Required for anything paid online — this, not the
   * screenshot, is what the owner reconciles against the bank statement — and
   * null for a session paid for at the ground or written in by staff.
   */
  utr?: string | null;
  /**
   * Set when the owner is taking this booking over the phone: no payment evidence
   * is expected, the number is not asked to verify itself, and the booking is
   * confirmed on the spot. Supplied by the admin route from the session, never
   * from a request body.
   */
  bookedBy?: string | null;
  /**
   * The number this device proved it controls, or null when verification is
   * switched off. Supplied by the route from a signed httpOnly cookie, never
   * from the request body — a client claiming "I am verified" proves nothing.
   */
  verifiedPhone?: string | null;
  /** When true a booking is refused unless `verifiedPhone` matches the number given. */
  requirePhoneVerification?: boolean;
  /**
   * The storage provider genuinely refused a valid screenshot for this hold.
   *
   * Supplied by the route from a signed httpOnly cookie that only the upload
   * route mints, and only after a real store failure. It is the single thing
   * that lets an online booking through without an image, so it must never be
   * derived from anything the client said.
   */
  storageFailed?: boolean;
  /**
   * The customer chose to pay the advance rather than the whole amount.
   *
   * A preference, not a figure: what that advance is worth is computed here from
   * the facility's own configuration and this booking's own total. A client that
   * sends this for a facility taking no advance simply pays in full.
   */
  payAdvance?: boolean;
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

  const bookedBy = input.bookedBy ?? null;

  // Checked before the slots are consumed, so a customer who has not verified
  // their number keeps the hold and can finish rather than losing the slot. Staff
  // on the phone are exempt: the owner is talking to the person.
  if (!bookedBy && input.requirePhoneVerification && input.verifiedPhone !== input.customerPhone) {
    throw appError("VALIDATION", "Please verify your mobile number before booking.");
  }

  const expired = units.some(
    (u) => u.status !== "HELD" || !u.holdUntil || u.holdUntil.getTime() <= now.getTime(),
  );
  if (expired) throw appError("HOLD_EXPIRED");

  const resourceId = units[0]!.resourceId;
  const date = units[0]!.date;
  const ctx = await loadResourceContext(db, resourceId, true);
  const { location, facility, resource, config } = ctx;
  const template = ctx.templateFor(date);

  // Price is recomputed from the server-side schedule; the browser never supplies it.
  const startMin = units[0]!.startMin;
  const endMin = units[units.length - 1]!.endMin;
  const resolvedUnits = resolveUnits(template, startMin, endMin);
  if (!resolvedUnits || resolvedUnits.length !== units.length) {
    log.warn("hold_schedule_drift", { resourceId: resourceId.toHexString(), date, startMin, endMin });
    throw appError("HOLD_INVALID", "The schedule changed while you were booking. Please select the slot again.");
  }

  // An overs booking is priced by its ball, and the ball it was held for is
  // recorded on the units themselves. A ball the owner deleted mid-booking has no
  // price any more, so the hold is refused rather than charged at some other rate.
  let overs: number | null = null;
  let ballType: BallType | null = null;
  let resolved = resolvedUnits;
  if (facility.kind === "OVERS") {
    const heldBallId = units[0]!.ballTypeId ?? "";
    ballType = findBallType(config.ballTypes, heldBallId);
    overs = units[0]!.overs ?? null;
    if (!ballType || overs === null) {
      log.warn("hold_overs_drift", { resourceId: resourceId.toHexString(), date, startMin, endMin, heldBallId });
      throw appError("HOLD_INVALID", "The prices changed while you were booking. Please select your session again.");
    }
    resolved = applyBallPricing(resolvedUnits, ballType);
  }

  // Decided from the hold and the stored configuration, never from the request:
  // a client that simply omits its payment details does not thereby book for free.
  //
  // What is demanded is the UTR rather than the image. A screenshot that would not
  // upload is a phone problem; the reference number the customer read off their
  // payment app is what the money is actually traced by, so that is the one thing
  // a booking cannot be made without. Staff writing in a phone booking are past
  // this entirely — they are standing next to the till.
  const payAtVenue = isPayAtVenue(config, overs);
  const utr = bookedBy ? null : (input.utr ?? null);
  if (!bookedBy && !payAtVenue && !utr) {
    throw appError("VALIDATION", "Please enter the 12-digit UPI reference number (UTR) to finish booking.");
  }

  /*
   * The screenshot is required for anything paid online.
   *
   * The one exemption is an upload our own storage refused: losing a booking the
   * customer has already paid for, because our provider had a bad minute, is a
   * worse outcome than an owner checking one payment against the statement by
   * hand. `storageFailed` is proof of exactly that, signed by this server — a
   * client cannot assert it, and a file the customer chose badly never produces
   * one, so the exemption cannot be reached by uploading rubbish on purpose.
   */
  const storageFailed = !bookedBy && !payAtVenue && Boolean(input.storageFailed);
  if (!bookedBy && !payAtVenue && !input.paymentScreenshotKey && !storageFailed) {
    throw appError(
      "VALIDATION",
      "Please upload a screenshot of your payment to finish booking.",
    );
  }

  // Same rule as the hold: the customer's booking window is a website rule, and
  // staff writing in a phone booking are not held to it. The date must still not
  // be in the past, which the hold already refused.
  if (bookedBy) assertNotPast(date, now);
  else assertBookableDate(date, config.bookingWindowDays, now);

  const priceBreakdown = resolved.map((u) => ({ startMin: u.startMin, endMin: u.endMin, price: u.price }));
  const amount = totalPrice(resolved);
  /*
   * What this customer owes online. The advance is offered only when the facility
   * is configured for one and the customer asked for it — and never on a session
   * already paid for at the ground or written in by staff, where there is no
   * online payment for an advance to be part of.
   */
  const advance = advanceFor(config, amount);
  const amountDueNow = !bookedBy && !payAtVenue && input.payAdvance && advance > 0 ? advance : amount;
  const unitStarts = units.map((u) => u.startMin);

  // Retry only for the (vanishingly rare) reference collision.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const reference = generateBookingReference();
    const bookingId = new ObjectId();
    const booking: BookingDoc = {
      _id: bookingId,
      reference,
      resourceId,
      facilityId: facility._id,
      locationId: location._id,
      locationName: location.name,
      facilityName: facility.name,
      resourceName: resource.name,
      date,
      startMin,
      endMin,
      unitStarts,
      overs,
      ballTypeName: ballType?.name ?? null,
      payAtVenue,
      amount,
      priceBreakdown,
      customerName: input.customerName,
      customerPhone: input.customerPhone,
      phoneVerified: input.verifiedPhone === input.customerPhone,
      createdBy: bookedBy,
      // A pay-at-venue session is confirmed immediately: there is nothing for an
      // admin to verify, and leaving it PENDING would put a queue in front of a
      // booking the owner has already agreed to take money for at the gate.
      // A staff booking is agreed on the telephone, so it is confirmed in the same
      // breath, exactly like a pay-at-the-ground session.
      status: payAtVenue || bookedBy ? "CONFIRMED" : "PENDING",
      paymentVerificationStatus: "PENDING",
      // An attempt is recorded whenever the customer paid — whether or not the
      // image made it through. Without this a payment whose screenshot failed
      // would leave no UTR anywhere for the owner to check.
      payments: utr
        ? [
            {
              id: crypto.randomUUID(),
              screenshotKey: input.paymentScreenshotKey,
              // Recorded rather than inferred from a null key: "the provider was
              // down" and "there was never an image" are the same absence and
              // completely different problems for whoever checks this later.
              uploadStatus: input.paymentScreenshotKey ? "UPLOADED" : storageFailed ? "FAILED" : "NONE",
              uploadFailureReason: !input.paymentScreenshotKey && storageFailed ? "STORAGE_UNAVAILABLE" : null,
              utr,
              uploadedAt: now,
              amount: null,
              status: "PENDING",
              reviewedBy: null,
              reviewedAt: null,
              note: null,
            },
          ]
        : [],
      amountPaid: 0,
      amountDueNow,
      paymentScreenshotKey: input.paymentScreenshotKey,
      paymentUploadedAt: input.paymentScreenshotKey ? now : null,
      rejectionReason: null,
      holdTokenHash,
      timeline: bookedBy
        ? [
            { event: "BOOKING_TAKEN_BY_STAFF", at: now, by: bookedBy, note: "Booked over the phone" },
            { event: "BOOKING_CONFIRMED", at: now, by: bookedBy },
          ]
        : payAtVenue
          ? [
              { event: "BOOKING_SUBMITTED", at: now, by: "customer" },
              { event: "BOOKING_CONFIRMED", at: now, by: "system", note: "Paying at the ground" },
            ]
          : [
              { event: "BOOKING_SUBMITTED", at: now, by: "customer" },
              {
                event: input.paymentScreenshotKey ? "PAYMENT_SCREENSHOT_UPLOADED" : "PAYMENT_UTR_ENTERED",
                at: now,
                by: "customer",
                note: "UTR " + utr,
              },
            ],
      createdAt: now,
      updatedAt: now,
    };

    try {
      await withTransaction(async (session, txDb) => {
        const dayBlock = await collections.dayBlocks(txDb).findOne({ resourceId, date }, { session });
        if (dayBlock) throw appError("DAY_BLOCKED");

        // Re-assert ownership inside the transaction: the hold must still be ours,
        // still HELD, and still unexpired at commit time. A pay-at-venue session
        // goes straight to BOOKED, because it is confirmed in the same breath.
        const claim = await collections.slotUnits(txDb).updateMany(
          { holdTokenHash, status: "HELD", holdUntil: { $gt: now }, bookingId: null },
          {
            $set: {
              status: payAtVenue || bookedBy ? "BOOKED" : "PENDING",
              bookingId,
              holdUntil: null,
              updatedAt: now,
            },
          },
          { session },
        );
        if (claim.modifiedCount !== units.length) throw appError("HOLD_EXPIRED");

        await collections.bookings(txDb).insertOne(booking, { session });
      });

      log.info("booking_submitted", { reference, resourceId: resourceId.toHexString(), date, startMin, endMin, amount });
      return booking;
    } catch (err) {
      if (isDuplicateKeyError(err) && attempt < 4) continue; // reference collision — try another

      // Two requests submitted this hold at the same moment (a double click on a
      // slow connection). One transaction claimed the units; this one found
      // nothing left to claim. Hand back the booking that did get created rather
      // than telling the customer their hold expired.
      const raced = await collections.bookings(db).findOne({ holdTokenHash });
      if (raced) return raced;

      rethrowBookingError(err, "booking_submit", { resourceId: resourceId.toHexString(), date, startMin, endMin });
    }
  }

  throw appError("INTERNAL", "Unable to process your booking right now. Please try again.");
}

/**
 * A booking the owner takes over the telephone.
 *
 * Built out of the same two steps a customer goes through — hold, then submit —
 * rather than writing slots directly. That is the whole point: the unique index,
 * the transaction, the day-block check, the closing-time arithmetic and the
 * server-side pricing are the ones already proven under load, so a booking
 * written in by hand cannot double-book a slot a customer is paying for at that
 * moment, and cannot be entered at a price the schedule does not say.
 *
 * What differs from a customer booking is only what staff are trusted with: the
 * customer's booking window does not apply, the number is not asked to verify
 * itself, no payment evidence is required, and the booking is confirmed on the
 * spot — the owner has just agreed it on the phone.
 */
export async function createManualBooking(input: {
  resourceId: ObjectId;
  date: string;
  startMin: number;
  endMin?: number;
  overs?: number;
  ballTypeId?: string;
  customerName: string;
  customerPhone: string;
  /** Money taken there and then. Zero means it is collected at the ground. */
  amountPaid?: number;
  note?: string;
  admin: { username: string };
  now?: Date;
}): Promise<BookingDoc> {
  const now = input.now ?? new Date();

  const hold = await createHold({
    resourceId: input.resourceId,
    date: input.date,
    startMin: input.startMin,
    endMin: input.endMin,
    overs: input.overs,
    ballTypeId: input.ballTypeId,
    bypassWindow: true,
    now,
  });

  const paid = input.amountPaid ?? 0;
  if (paid > hold.amount) {
    // Refused rather than banked: a booking that has taken more than it costs is
    // indistinguishable afterwards from a mis-keyed amount, and the owner would
    // be chasing a refund they cannot see.
    await releaseHold(hold.holdToken);
    throw appError(
      "VALIDATION",
      `That is more than the booking costs (${hold.amount}). Enter what was actually collected.`,
    );
  }

  let booking: BookingDoc;
  try {
    booking = await submitBooking({
      holdToken: hold.holdToken,
      customerName: input.customerName,
      customerPhone: input.customerPhone,
      paymentScreenshotKey: null,
      bookedBy: input.admin.username,
      now,
    });
  } catch (err) {
    // The slots are ours for the next few minutes and nobody is coming back for
    // them, so hand them straight back rather than leaving a phantom hold on the
    // grid while the owner is still on the call.
    await releaseHold(hold.holdToken);
    throw err;
  }

  log.info("booking_taken_by_staff", {
    reference: booking.reference,
    resourceId: input.resourceId.toHexString(),
    date: input.date,
    startMin: booking.startMin,
    endMin: booking.endMin,
    amount: booking.amount,
    collected: paid,
    admin: input.admin.username,
  });

  if (paid > 0) {
    return recordManualPayment({
      bookingId: booking._id,
      amount: paid,
      note: input.note || "Collected when the booking was taken over the phone",
      admin: input.admin,
    });
  }

  return booking;
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
  /** Present when the admin is entering a UPI payment they can see in the statement. */
  utr?: string | null;
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
    // An admin typing in money they were handed. There was no image to upload.
    uploadStatus: "NONE",
    uploadFailureReason: null,
    utr: input.utr ?? null,
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
      /**
       * A pay-at-the-ground booking — and one the owner took over the phone — is
       * CONFIRMED from the moment it is made and still owes its money, so this is
       * the only way that cash ever gets recorded. Without it the owner takes ₹720
       * at the gate and the booking reads as unpaid for ever.
       */
      $or: [
        { status: "PENDING" },
        { status: "CONFIRMED", payAtVenue: true },
        { status: "CONFIRMED", createdBy: { $ne: null } },
      ],
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
  /** Null when the upload failed; the UTR below is what the payment is traced by. */
  screenshotKey: string | null;
  /**
   * The store refused a valid image for this attempt too. Proven server-side,
   * exactly as on first submission — a retry is not a way round the requirement
   * either.
   */
  storageFailed?: boolean;
  utr: string;
  now?: Date;
}): Promise<BookingDoc> {
  const db = await getDb();
  const now = input.now ?? new Date();
  if (!input.screenshotKey && !input.storageFailed) {
    throw appError("VALIDATION", "Please upload a screenshot of your payment.");
  }
  const attempt: PaymentAttempt = {
    id: crypto.randomUUID(),
    screenshotKey: input.screenshotKey,
    uploadStatus: input.screenshotKey ? "UPLOADED" : "FAILED",
    uploadFailureReason: input.screenshotKey ? null : "STORAGE_UNAVAILABLE",
    utr: input.utr,
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
              [
                {
                  $literal: timelineEntry(
                    input.screenshotKey ? "PAYMENT_SCREENSHOT_UPLOADED" : "PAYMENT_UTR_ENTERED",
                    "customer",
                    "UTR " + input.utr,
                  ),
                },
              ],
            ],
          },
          // Left alone when no image came through, so the admin screen keeps
          // pointing at the last screenshot that actually exists.
          ...(input.screenshotKey ? { paymentScreenshotKey: input.screenshotKey } : {}),
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

    /**
     * A pay-at-venue session is CONFIRMED the moment it is made, so without this
     * a customer who never turned up would hold the machine for good — there
     * would be no state from which the slots could ever be released. It is only
     * allowed while nothing has been collected: once money is recorded against a
     * booking, cancelling it is a refund conversation, not a click.
     */
    const cancellableConfirmed =
      booking.status === "CONFIRMED" && booking.payAtVenue && (booking.amountPaid ?? 0) === 0;

    if (booking.status !== "PENDING" && !cancellableConfirmed) {
      throw appError(
        "CONFLICT",
        booking.status === "CONFIRMED" && (booking.amountPaid ?? 0) > 0
          ? "This booking has been paid for. Refund the customer before cancelling it."
          : `This booking is ${booking.status.toLowerCase()} and can no longer be rejected.`,
      );
    }

    await collections.slotUnits(txDb).updateMany(
      { bookingId, status: { $in: ["PENDING", "HELD", ...(cancellableConfirmed ? ["BOOKED" as const] : [])] } },
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
      { _id: bookingId, status: booking.status },
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
  resourceId: ObjectId,
  date: string,
  startMin: number,
  endMin: number,
  now: Date = new Date(),
): Promise<BlockConflict[]> {
  const db = await getDb();
  const units = await collections
    .slotUnits(db)
    .find({ resourceId, date, startMin: { $gte: startMin, $lt: endMin } })
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
  resourceId: ObjectId;
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
  const { resource, template } = await loadResourceContext(db, input.resourceId, false);

  const conflicts = await findBlockConflicts(input.resourceId, input.date, input.startMin, input.endMin, now);
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
          { resourceId: input.resourceId, date: input.date, startMin: unit.startMin, status: { $ne: "BOOKED" } },
          {
            $set: {
              locationId: resource.locationId,
              facilityId: resource.facilityId,
              endMin: unit.endMin,
              status: "BLOCKED",
              holdTokenHash: null,
              holdUntil: null,
              bookingId: null,
              price: unit.price,
              ballTypeId: null,
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
    log.error("block_slots_failed", { err, resourceId: input.resourceId.toHexString(), date: input.date });
    throw appError("INTERNAL", "Unable to block those slots right now. Please try again.");
  }

  log.info("slots_blocked", {
    resourceId: input.resourceId.toHexString(),
    date: input.date,
    startMin: input.startMin,
    endMin: input.endMin,
    blocked,
    forced: input.force,
  });
  return { blocked, conflicts: input.force ? conflicts : [] };
}

export async function unblockSlots(input: {
  resourceId: ObjectId;
  date: string;
  startMin: number;
  endMin: number;
}): Promise<number> {
  const db = await getDb();
  const result = await collections.slotUnits(db).updateMany(
    {
      resourceId: input.resourceId,
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
 * Close a resource for a whole date with ONE document rather than materialising
 * every slot. The availability query consults it, so it cannot be bypassed.
 */
export async function blockDay(input: {
  resourceId: ObjectId;
  date: string;
  reason: string;
  force: boolean;
  admin: { username: string };
  now?: Date;
}): Promise<BlockOutcome> {
  const now = input.now ?? new Date();
  assertNotPast(input.date, now);
  const db = await getDb();
  const { resource, config } = await loadResourceContext(db, input.resourceId, false);

  const conflicts = await findBlockConflicts(input.resourceId, input.date, config.openMin, config.closeMin, now);
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
    { resourceId: input.resourceId, date: input.date },
    {
      $set: {
        locationId: resource.locationId,
        facilityId: resource.facilityId,
        reason: input.reason,
        blockedBy: input.admin.username,
        blockedAt: now,
      },
      $setOnInsert: { resourceId: input.resourceId, date: input.date },
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
      { resourceId: input.resourceId, date: input.date, status: { $in: ["HELD", "PENDING"] } },
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

  log.info("day_blocked", { resourceId: input.resourceId.toHexString(), date: input.date, forced: input.force });
  return { blocked: 1, conflicts: input.force ? conflicts : [] };
}

export async function unblockDay(resourceId: ObjectId, date: string): Promise<boolean> {
  const db = await getDb();
  const result = await collections.dayBlocks(db).deleteOne({ resourceId, date });
  return result.deletedCount > 0;
}

/**
 * Every resource a block should cover, for admins working at facility or ground
 * level: "close Medipally on Sunday" means the box, the nets and the machine,
 * and "close pickleball" means both courts. Each one is still blocked by its own
 * per-resource document, so the availability path never learns about scopes.
 */
export async function resolveBlockTargets(input: {
  resourceId?: ObjectId;
  facilityId?: ObjectId;
  locationId?: ObjectId;
}): Promise<ObjectId[]> {
  if (input.resourceId) return [input.resourceId];

  const db = await getDb();
  const filter = input.facilityId
    ? { facilityId: input.facilityId }
    : input.locationId
      ? { locationId: input.locationId }
      : null;
  if (!filter) throw appError("VALIDATION", "Choose what to block.");

  const resources = await collections.resources(db).find(filter).sort({ sortOrder: 1 }).toArray();
  if (resources.length === 0) throw appError("NOT_FOUND", "There is nothing bookable there to block.");
  return resources.map((r) => r._id);
}

/* ──────────────────────────────────────────────────────────────────────────
 * Screenshot retention
 * ────────────────────────────────────────────────────────────────────── */

/**
 * How long a payment screenshot is kept after the slot has been played.
 *
 * Long enough to settle a dispute while the match is fresh, short enough that
 * storage never becomes a problem: at 20 bookings a day this keeps roughly 140
 * images alive, a few dozen megabytes.
 */
export const SCREENSHOT_RETAIN_DAYS = 7;

/**
 * Deletes screenshots for bookings played more than {@link SCREENSHOT_RETAIN_DAYS}
 * ago, keeping every payment record intact.
 *
 * What is removed is only the image file. The attempt keeps its amount, its
 * verdict, who approved it and when, so the money trail and the audit log are
 * untouched and a booking can still be reconciled years later.
 *
 * Safe to run repeatedly: a booking is only marked once its files are actually
 * gone, and deleting an object that has already been deleted is not an error.
 */
/**
 * Which stored files nothing is going to claim.
 *
 * Pure, and separate from the storage call, so the rule can be tested without a
 * bucket: a file is only an orphan once it is old enough that any booking it
 * could have belonged to would long since have been submitted. A hold lives five
 * minutes, so a day is not a close call — it only ever catches uploads that were
 * genuinely abandoned.
 */
export function selectOrphanScreenshots(
  stored: StoredScreenshot[],
  referenced: Set<string>,
  cutoff: Date,
): StoredScreenshot[] {
  return stored.filter((file) => !referenced.has(file.key) && file.uploadedAt.getTime() < cutoff.getTime());
}

/**
 * Delete screenshots that belong to no booking at all.
 *
 * The other purge walks bookings and removes the images of games already played.
 * This one walks the STORE, because a customer who uploads a screenshot and then
 * abandons the payment screen leaves a file that no booking names — invisible to
 * anything looking at the database, and paid for every month regardless.
 */
export async function purgeOrphanScreenshots(input?: {
  /** How old an unclaimed file must be before it counts as abandoned. */
  minAgeHours?: number;
  now?: Date;
}): Promise<{ scanned: number; deleted: number; failed: number }> {
  const now = input?.now ?? new Date();
  const cutoff = new Date(now.getTime() - (input?.minAgeHours ?? 24) * 3_600_000);

  const stored = await listStoredScreenshots();
  if (stored.length === 0) return { scanned: 0, deleted: 0, failed: 0 };

  const db = await getDb();
  const bookings = await collections
    .bookings(db)
    .find({}, { projection: { paymentScreenshotKey: 1, "payments.screenshotKey": 1 } })
    .toArray();

  const referenced = new Set<string>();
  for (const booking of bookings) {
    if (booking.paymentScreenshotKey) referenced.add(booking.paymentScreenshotKey);
    for (const attempt of booking.payments ?? []) {
      if (attempt.screenshotKey) referenced.add(attempt.screenshotKey);
    }
  }

  const orphans = selectOrphanScreenshots(stored, referenced, cutoff);
  let deleted = 0;
  let failed = 0;
  for (const file of orphans) {
    try {
      await deletePaymentScreenshot(file.key);
      deleted += 1;
    } catch (err) {
      failed += 1;
      log.warn("orphan_screenshot_delete_failed", { key: file.key, error: (err as Error).message });
    }
  }

  log.info("orphan_screenshots_purged", { scanned: stored.length, deleted, failed });
  return { scanned: stored.length, deleted, failed };
}

export async function purgeExpiredScreenshots(input?: {
  retainDays?: number;
  now?: Date;
}): Promise<{ bookings: number; deleted: number; failed: number }> {
  const now = input?.now ?? new Date();
  const retainDays = input?.retainDays ?? SCREENSHOT_RETAIN_DAYS;
  // Booking dates are plain IST day strings, so the cutoff is one too and the
  // comparison is a lexical one Mongo can answer from the index.
  const cutoff = istDateString(new Date(now.getTime() - retainDays * 86_400_000));

  const db = await getDb();
  const stale = await collections
    .bookings(db)
    .find({ date: { $lt: cutoff }, "payments.screenshotKey": { $ne: null } })
    .toArray();

  let deleted = 0;
  let failed = 0;
  let touched = 0;

  for (const booking of stale) {
    const keys = [
      ...new Set(
        [...(booking.payments ?? []).map((p) => p.screenshotKey), booking.paymentScreenshotKey].filter(
          (k): k is string => Boolean(k),
        ),
      ),
    ];

    let allGone = true;
    for (const key of keys) {
      try {
        await deletePaymentScreenshot(key);
        deleted += 1;
      } catch (err) {
        // A key that cannot name a real object — legacy or malformed data — has
        // nothing behind it to delete. Retrying it every night forever would log
        // an error a day and keep the booking pinned in the queue, so clear it.
        if (err instanceof AppError && err.code === "NOT_FOUND") continue;

        // Anything else is a real failure: leave the booking untouched so the
        // next run tries again, rather than marking an image expired while the
        // file is still sitting in the bucket.
        allGone = false;
        log.error("screenshot_purge_failed", { err, reference: booking.reference, key });
      }
    }
    if (!allGone) {
      failed += 1;
      continue;
    }

    await collections.bookings(db).updateOne({ _id: booking._id }, [
      {
        $set: {
          payments: {
            $map: {
              input: { $ifNull: ["$payments", []] },
              as: "p",
              in: {
                $cond: [
                  { $ne: ["$$p.screenshotKey", null] },
                  { $mergeObjects: ["$$p", { screenshotKey: null, screenshotExpiredAt: now }] },
                  "$$p",
                ],
              },
            },
          },
          paymentScreenshotKey: null,
          updatedAt: now,
        },
      },
    ]);
    touched += 1;
  }

  if (touched || failed) {
    log.info("screenshots_purged", { bookings: touched, deleted, failed, cutoff, retainDays });
  }
  return { bookings: touched, deleted, failed };
}
