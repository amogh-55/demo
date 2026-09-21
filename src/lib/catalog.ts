import "server-only";
import { collections, getDb } from "./db";
import { buildDayTemplate } from "./booking/schedule";
import type { FacilityKind } from "./types";

/**
 * The public catalogue: what can be booked, where, and roughly what it costs.
 *
 * Read in one pass and assembled in memory rather than with a per-location query,
 * because a ground page needs the whole tree and the whole tree is a few dozen
 * documents. Nothing customer-identifying is in here.
 */
export interface PublicResource {
  id: string;
  name: string;
  slug: string;
}

export interface PublicFacility {
  id: string;
  name: string;
  slug: string;
  kind: FacilityKind;
  description: string;
  resources: PublicResource[];
  /** Cheapest sellable slot, for the "from ₹X" line. Null when nothing is priced. */
  fromPrice: number | null;
  /** OVERS facilities: the cheapest ball, for one block of overs. */
  fromPricePerBlock: number | null;
  /** OVERS facilities: how many overs that block is. */
  oversPerSlot: number;
  /**
   * The owner's own price bands, so the published pricing table is the same data
   * the booking engine charges from and can never drift from it. Empty for an
   * OVERS facility, which is priced by ball rather than by time of day.
   */
  priceBands: Array<{ fromMin: number; toMin: number; price: number }>;
  /** The second table, for grounds that charge more at the weekend. Empty otherwise. */
  weekendBands: Array<{ fromMin: number; toMin: number; price: number }>;
  /** Which days those apply to: 0 Sunday … 6 Saturday. */
  weekendDays: number[];
  /** OVERS facilities: what one block of overs costs, per ball. */
  ballTypes: Array<{ id: string; name: string; pricePerSlot: number }>;
  slotMinutes: number;
  openMin: number;
  closeMin: number;
  bookingWindowDays: number;
}

export interface PublicLocationTree {
  id: string;
  name: string;
  slug: string;
  address: string;
  mapsUrl: string;
  description: string;
  image: string;
  phone: string;
  facilities: PublicFacility[];
}

export async function getPublicCatalog(): Promise<PublicLocationTree[]> {
  const db = await getDb();
  const [locations, facilities, resources] = await Promise.all([
    collections.locations(db).find({ active: true }).sort({ name: 1 }).toArray(),
    collections.facilities(db).find({ active: true }).sort({ sortOrder: 1, name: 1 }).toArray(),
    collections.resources(db).find({ active: true }).sort({ sortOrder: 1, name: 1 }).toArray(),
  ]);

  const resourcesByFacility = new Map<string, PublicResource[]>();
  for (const r of resources) {
    const key = r.facilityId.toHexString();
    const list = resourcesByFacility.get(key) ?? [];
    list.push({ id: r._id.toHexString(), name: r.name, slug: r.slug });
    resourcesByFacility.set(key, list);
  }

  const facilitiesByLocation = new Map<string, PublicFacility[]>();
  for (const f of facilities) {
    const own = resourcesByFacility.get(f._id.toHexString()) ?? [];
    // A facility with nothing bookable under it is not offered: there would be
    // nothing for a customer to land on after tapping it.
    if (own.length === 0) continue;

    const slots = buildDayTemplate(f.config);
    const ballPrices = f.config.ballTypes.map((b) => b.pricePerSlot);
    const key = f.locationId.toHexString();
    const list = facilitiesByLocation.get(key) ?? [];
    list.push({
      id: f._id.toHexString(),
      name: f.name,
      slug: f.slug,
      kind: f.kind,
      description: f.description,
      resources: own,
      fromPrice: f.kind === "OVERS" || slots.length === 0 ? null : Math.min(...slots.map((s) => s.price)),
      fromPricePerBlock: f.kind === "OVERS" && ballPrices.length > 0 ? Math.min(...ballPrices) : null,
      oversPerSlot: f.kind === "OVERS" ? f.config.oversPerSlot : 0,
      priceBands: f.kind === "OVERS" ? [] : f.config.priceRules.map((r) => ({ ...r })),
      // Empty unless the owner charges differently at the weekend, which is what
      // lets the pricing card show one table or two without being told which.
      weekendBands: f.kind === "OVERS" ? [] : (f.config.weekendPriceRules ?? []).map((r) => ({ ...r })),
      weekendDays: f.kind === "OVERS" ? [] : (f.config.weekendDays ?? []),
      ballTypes: f.kind === "OVERS" ? f.config.ballTypes.map((b) => ({ ...b })) : [],
      slotMinutes: f.config.slotMinutes,
      openMin: f.config.openMin,
      closeMin: f.config.closeMin,
      bookingWindowDays: f.config.bookingWindowDays,
    });
    facilitiesByLocation.set(key, list);
  }

  return locations
    .map((l) => ({
      id: l._id.toHexString(),
      name: l.name,
      slug: l.slug,
      address: l.address,
      mapsUrl: l.mapsUrl ?? "",
      description: l.description,
      image: l.image,
      phone: l.phone,
      facilities: facilitiesByLocation.get(l._id.toHexString()) ?? [],
    }))
    .filter((l) => l.facilities.length > 0);
}

/** The widest booking window on offer, for the date picker's upper bound. */
export function widestBookingWindow(catalog: PublicLocationTree[], fallback: number): number {
  // Filtered, not trusted: one facility whose config predates this field makes
  // Math.max return NaN, and a NaN booking window travels all the way to the
  // customer's date picker before anything notices.
  const windows = catalog
    .flatMap((l) => l.facilities.map((f) => f.bookingWindowDays))
    .filter((n): n is number => Number.isFinite(n) && n >= 0);
  return windows.length > 0 ? Math.max(...windows) : fallback;
}
