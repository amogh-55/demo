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
 * The atomic bookable units for a facility's operating day.
 * Half-open intervals: [start, end). 5–7 and 7–9 are adjacent, never overlapping.
 */
export function buildDayTemplate(
  config: Pick<FacilityConfig, "openMin" | "closeMin" | "slotMinutes" | "priceRules">,
): SlotUnitTemplate[] {
  const units: SlotUnitTemplate[] = [];
  // A zero or negative slot length would loop forever. The admin API rejects one,
  // so this only guards against a configuration edited straight into the database.
  if (!Number.isFinite(config.slotMinutes) || config.slotMinutes <= 0) return units;
  for (let start = config.openMin; start + config.slotMinutes <= config.closeMin; start += config.slotMinutes) {
    const price = priceForStart(config.priceRules, start);
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
  for (let i = 0; i < slots; i += 1) {
    if (!freeStarts.has(startMin + i * slotMinutes)) return false;
  }
  return true;
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
