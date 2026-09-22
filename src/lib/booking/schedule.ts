import { istDateString, istInstant, istWeekday } from "@/lib/time";
import type { BallType, FacilityConfig, PriceRule } from "@/lib/types";

export interface SlotUnitTemplate {
  startMin: number;
  endMin: number;
  price: number;
}

/** Price for the unit starting at `startMin`. null when no rule covers it. */
export function priceForStart(rules: PriceRule[], startMin: number): number | null {
  const rule = rules.find((r) => startMin >= r.fromMin && startMin < r.toMin);
  return rule ? rule.price : null;
}

/**
 * Whether a date is charged at weekend rates.
 *
 * Both halves matter: a ground with no weekend table charges one price all week,
 * and a ground with one charges it only on the days it named.
 */
export function isWeekendRate(
  config: Pick<FacilityConfig, "weekendPriceRules" | "weekendDays">,
  date: string,
): boolean {
  if (!config.weekendPriceRules || config.weekendPriceRules.length === 0) return false;
  return (config.weekendDays ?? []).includes(istWeekday(date));
}

/** The price table in force on a given date. */
export function rulesForDate(
  config: Pick<FacilityConfig, "priceRules" | "weekendPriceRules" | "weekendDays">,
  date?: string,
): PriceRule[] {
  return date && isWeekendRate(config, date) ? (config.weekendPriceRules ?? []) : config.priceRules;
}

/**
 * The atomic bookable units for a facility's operating day.
 * Half-open intervals: [start, end). 5–7 and 7–9 are adjacent, never overlapping.
 *
 * The date is what decides which price table is used, so it is passed wherever a
 * real booking is being priced. Left out, the weekday table is used — which is
 * right for the "from ₹700" on the home page and wrong for anything that takes
 * money, so every path that does takes the date.
 */
export function buildDayTemplate(
  config: Pick<FacilityConfig, "openMin" | "closeMin" | "slotMinutes" | "priceRules" | "weekendPriceRules" | "weekendDays">,
  date?: string,
): SlotUnitTemplate[] {
  const units: SlotUnitTemplate[] = [];
  // A zero or negative slot length would loop forever. The admin API rejects one,
  // so this only guards against a configuration edited straight into the database.
  if (!Number.isFinite(config.slotMinutes) || config.slotMinutes <= 0) return units;
  const rules = rulesForDate(config, date);
  for (let start = config.openMin; start + config.slotMinutes <= config.closeMin; start += config.slotMinutes) {
    const price = priceForStart(rules, start);
    if (price === null) continue; // Unpriced time is not sellable.
    units.push({ startMin: start, endMin: start + config.slotMinutes, price });
  }
  return units;
}

/**
 * Resolve a customer-facing [startMin, endMin) range into the atomic units it owns.
 * Rejects ranges that are not exactly covered by consecutive configured units —
 * the request must line up with the schedule, no partial units.
 */
export function resolveUnits(template: SlotUnitTemplate[], startMin: number, endMin: number): SlotUnitTemplate[] | null {
  if (endMin <= startMin) return null;
  const startIndex = template.findIndex((u) => u.startMin === startMin);
  if (startIndex === -1) return null;

  const chosen: SlotUnitTemplate[] = [];
  let cursor = startMin;
  for (let i = startIndex; i < template.length; i += 1) {
    const unit = template[i]!;
    if (unit.startMin !== cursor) return null; // gap in the schedule
    chosen.push(unit);
    cursor = unit.endMin;
    if (cursor === endMin) return chosen;
    if (cursor > endMin) return null;
  }
  return null;
}

export function totalPrice(units: SlotUnitTemplate[]): number {
  return units.reduce((sum, u) => sum + u.price, 0);
}

/* ──────────────────────────────────────────────────────────────────────────
 * Overs-based facilities (bowling machines)
 * ────────────────────────────────────────────────────────────────────── */

/**
 * How many slots a number of overs buys, or null if it is not a whole number of
 * them.
 *
 * Ten overs to a slot means 10, 20, 30 and 70 all work and 25 does not — there is
 * no quarter of a slot to reserve, and charging for 30 while selling 25 would be
 * the kind of quiet rounding a customer finds out about at the till. There is no
 * upper limit here: how long a session may run is decided by the clock, when the
 * units it needs run past closing time.
 */
export function slotsForOvers(oversPerSlot: number, overs: number): number | null {
  if (!Number.isInteger(overs) || overs <= 0) return null;
  if (!Number.isInteger(oversPerSlot) || oversPerSlot <= 0) return null;
  if (overs % oversPerSlot !== 0) return null;
  return overs / oversPerSlot;
}

/** Minutes on the machine for a number of overs, or null if it does not divide. */
export function minutesForOvers(oversPerSlot: number, slotMinutes: number, overs: number): number | null {
  const slots = slotsForOvers(oversPerSlot, overs);
  return slots === null ? null : slots * slotMinutes;
}

export function findBallType(ballTypes: BallType[], id: string): BallType | null {
  return ballTypes.find((b) => b.id === id) ?? null;
}

/** Re-price a resolved run of units for the chosen ball: one block price each. */
export function applyBallPricing(units: SlotUnitTemplate[], ball: BallType): SlotUnitTemplate[] {
  return units.map((u) => ({ ...u, price: ball.pricePerSlot }));
}

/**
 * Whether a session of `slots` consecutive units can start at `startMin`.
 *
 * A bowling session is a run, so 40 overs at 8:00 needs 8:00, 8:15, 8:30 and 8:45
 * all free. Offering a start time that cannot actually be fulfilled just moves the
 * failure to the payment screen.
 */
export function runIsFree(
  slotMinutes: number,
  freeStarts: ReadonlySet<number>,
  startMin: number,
  slots: number,
): boolean {
  return freeRunLength(slotMinutes, freeStarts, startMin, slots) === slots;
}

/**
 * How many consecutive units are free from `startMin`, counting no further than
 * `max`.
 *
 * What a refused start time is actually worth. "Not enough time" leaves the
 * customer to work out by hand which of sixty-eight buttons the clash is behind;
 * the run length says what they can have from the start they picked, which is the
 * question they were asking. It stops at `max` because nothing beyond the session
 * they chose is worth counting.
 */
export function freeRunLength(
  slotMinutes: number,
  freeStarts: ReadonlySet<number>,
  startMin: number,
  max: number,
): number {
  let slots = 0;
  while (slots < max && freeStarts.has(startMin + slots * slotMinutes)) slots += 1;
  return slots;
}

/**
 * The overs options worth offering as quick picks, up to what the day can hold.
 *
 * Generated rather than configured: the rule is one number, so a ladder stored
 * beside it could only ever disagree with it.
 */
export function oversLadder(oversPerSlot: number, slotMinutes: number, openMin: number, closeMin: number): number[] {
  const maxSlots = Math.floor((closeMin - openMin) / slotMinutes);
  const ladder: number[] = [];
  for (let slots = 1; slots <= maxSlots; slots += 1) ladder.push(slots * oversPerSlot);
  return ladder;
}

/**
 * Every clock hour a session touches, as minutes-of-day: a 90-minute run from
 * 6:45 touches 6:00, 7:00 and 8:00.
 *
 * Used to decide which hours of the picker to open, so a session that runs past
 * the hour it starts in is shown whole rather than cut off at the boundary.
 */
export function hoursTouched(startMin: number, endMin: number): number[] {
  if (!Number.isFinite(startMin) || !Number.isFinite(endMin) || endMin <= startMin) return [];
  const hours: number[] = [];
  for (let m = Math.floor(startMin / 60) * 60; m < endMin; m += 60) hours.push(m);
  return hours;
}

/**
 * What a customer may pay now to hold this booking, in whole rupees.
 *
 * Zero when the facility takes no advance, and zero when the sum would be the
 * whole amount anyway — half of nothing is not a payment option, and offering
 * "pay 100% now" beside "pay 100% now" is just two buttons.
 *
 * Rounded up, so the ground is never short by the half-rupee: half of ₹701 is
 * ₹351 now and ₹350 at the gate.
 */
export function advanceFor(config: FacilityConfig, amount: number): number {
  const percent = config.advancePercent ?? 0;
  if (percent <= 0 || percent >= 100 || amount <= 0) return 0;
  const advance = Math.ceil((amount * percent) / 100);
  return advance > 0 && advance < amount ? advance : 0;
}



/**
 * Whether a slot's start time is already behind us.
 *
 * Shared by the customer grid and the admin one because they disagreed: the
 * public page greyed this morning out, the admin page offered it, and staff only
 * found out by picking 6 AM, filling in a whole phone booking and being refused
 * on save. The clock is the same clock for everyone.
 */
export function isPastSlot(date: string, startMin: number, now: Date): boolean {
  return date <= istDateString(now) && istInstant(date, startMin).getTime() <= now.getTime();
}
