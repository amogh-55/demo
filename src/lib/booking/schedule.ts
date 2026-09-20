import type { PriceRule, SlotConfigDoc } from "@/lib/types";

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
 * The atomic bookable units for a location's operating day.
 * Half-open intervals: [start, end). 5–7 and 7–9 are adjacent, never overlapping.
 */
export function buildDayTemplate(config: Pick<SlotConfigDoc, "openMin" | "closeMin" | "slotMinutes" | "priceRules">): SlotUnitTemplate[] {
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
