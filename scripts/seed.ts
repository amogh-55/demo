/**
 * Seeds the three grounds, what each one sells, and the bookable courts under
 * those.
 *
 * Deliberately creates NO bookings and NO customers — production must never be
 * polluted with fake demand. Running it twice is safe: everything is upserted by
 * slug, and an existing facility keeps the hours and prices the owner has since
 * edited rather than being reset to these starting values.
 *
 *   npm run seed
 *
 * Addresses and Google Maps links are left blank on purpose. The owner supplies
 * the real ones in Admin → Locations; inventing them would put a wrong address in
 * front of a customer driving to a match.
 */
import { MongoClient, ObjectId } from "mongodb";
import { config as loadEnv } from "./env";

loadEnv();

const HOUR = 60;

/** Shared by everything sold by the hour. */
const HOURLY_BASE = {
  slotMinutes: 60,
  openMin: 6 * HOUR, // 6:00 AM
  closeMin: 23 * HOUR, // 11:00 PM
  bookingWindowDays: 30,
  holdMinutes: 5,
  // Empty means one price every day, which is where every ground starts.
  weekendPriceRules: [] as Array<{ fromMin: number; toMin: number; price: number }>,
  weekendDays: [5, 6, 0],
  oversPerSlot: 0,
  payAtVenueMaxOvers: 0,
  ballTypes: [] as Array<{ id: string; name: string; pricePerSlot: number }>,
};

/**
 * The bowling machine.
 *
 * Ten overs to a 15-minute block, and one block costs one ball price: ₹180 for
 * 10 leather overs, ₹360 for 20, ₹1,260 for 70; synthetic is ₹100 a block.
 * There is no ceiling — a customer may book as many blocks as the day still has
 * room for.
 *
 * Up to 40 overs is confirmed on the spot and paid for at the ground; beyond
 * that an online payment is asked for first. Every number here is editable in
 * the admin panel.
 */
const BOWLING_BASE = {
  slotMinutes: 15,
  openMin: 6 * HOUR,
  closeMin: 23 * HOUR,
  bookingWindowDays: 30,
  holdMinutes: 5,
  priceRules: [{ fromMin: 6 * HOUR, toMin: 23 * HOUR, price: 0 }],
  // A bowling session is priced by its ball, so it has no weekday/weekend table.
  weekendPriceRules: [] as Array<{ fromMin: number; toMin: number; price: number }>,
  weekendDays: [5, 6, 0],
  oversPerSlot: 10,
  payAtVenueMaxOvers: 40,
  ballTypes: [
    { id: "synthetic", name: "Synthetic ball", pricePerSlot: 100 },
    { id: "leather", name: "Leather ball", pricePerSlot: 180 },
  ],
};

interface SeedFacility {
  name: string;
  slug: string;
  kind: "HOURLY" | "OVERS";
  description: string;
  config: Record<string, unknown>;
  resources: string[];
}

interface SeedLocation {
  name: string;
  slug: string;
  address: string;
  mapsUrl: string;
  description: string;
  image: string;
  phone: string;
  facilities: SeedFacility[];
}

const LOCATIONS: SeedLocation[] = [
  {
    name: "Medipally",
    slug: "medipally",
    address: "Medipally, Hyderabad, Telangana",
    mapsUrl: "",
    description: "Box cricket, practice nets and a bowling machine under floodlights.",
    image: "/images/floodlight-turf.jpg",
    phone: "7730825514",
    facilities: [
      {
        name: "Box Cricket",
        slug: "box-cricket",
        kind: "HOURLY",
        description: "Full box-cricket turf, booked by the hour.",
        config: {
          ...HOURLY_BASE,
          priceRules: [
            { fromMin: 6 * HOUR, toMin: 12 * HOUR, price: 700 },
            { fromMin: 12 * HOUR, toMin: 17 * HOUR, price: 800 },
            { fromMin: 17 * HOUR, toMin: 23 * HOUR, price: 1200 },
          ],
        },
        resources: ["Box Cricket"],
      },
      {
        name: "Nets",
        slug: "nets",
        kind: "HOURLY",
        description: "Practice nets, booked by the hour.",
        config: {
          ...HOURLY_BASE,
          priceRules: [
            { fromMin: 6 * HOUR, toMin: 17 * HOUR, price: 400 },
            { fromMin: 17 * HOUR, toMin: 23 * HOUR, price: 600 },
          ],
        },
        resources: ["Nets"],
      },
      {
        name: "Bowling Machine",
        slug: "bowling-machine",
        kind: "OVERS",
        description: "Pick your overs and ball type. 10 overs takes 15 minutes.",
        config: BOWLING_BASE,
        resources: ["Bowling Machine"],
      },
    ],
  },
  {
    name: "Vanasthalipuram",
    slug: "vanasthalipuram",
    address: "Vanasthalipuram, Hyderabad, Telangana",
    mapsUrl: "",
    description: "Bowling machine sessions by the over.",
    image: "/images/box-cricket-turf.jpg",
    phone: "7730825514",
    facilities: [
      {
        name: "Bowling Machine",
        slug: "bowling-machine",
        kind: "OVERS",
        description: "Pick your overs and ball type. 10 overs takes 15 minutes.",
        config: BOWLING_BASE,
        resources: ["Bowling Machine"],
      },
    ],
  },
  {
    // The ground is at Uppal, per the owner. Slug stays "pickleball" so links
    // already shared keep working.
    name: "Uppal",
    slug: "pickleball",
    address: "Uppal, Hyderabad, Telangana",
    mapsUrl: "",
    description: "Two floodlit pickleball courts, booked by the hour.",
    image: "/images/cricket-sunset.jpg",
    phone: "7730825514",
    facilities: [
      {
        name: "Pickleball",
        slug: "pickleball",
        kind: "HOURLY",
        description: "Two courts. Both can be played at the same time.",
        config: {
          ...HOURLY_BASE,
          priceRules: [{ fromMin: 6 * HOUR, toMin: 23 * HOUR, price: 300 }],
        },
        // The whole point of the pickleball ground: two independent courts, so
        // 6–7 PM can be sold twice over without either being double booked.
        resources: ["Court 1", "Court 2"],
      },
    ],
  },
];

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Brings a stored facility config up to the current shape.
 *
 * Facilities seeded before bowling was priced by the block still carry a
 * `ballTypes[].pricePerHour` and an `oversOptions` ladder. Read by today's code
 * those are simply absent, which puts an undefined price in front of a customer.
 * Renaming the field keeps the owner's number and gives it its intended meaning:
 * ₹180 was always "₹180 for ten overs".
 *
 * Only ever fills in what is missing, so an admin's later edits are never undone.
 */
function upgradeConfig(config: Record<string, any>, kind: "HOURLY" | "OVERS"): Record<string, unknown> | null {
  const next = { ...config };
  let changed = false;

  if (kind === "OVERS") {
    if (next.oversPerSlot === undefined) {
      // The old ladder said "10 overs = 15 minutes"; one slot's worth of overs is
      // that first option scaled to a single slot.
      const first = Array.isArray(next.oversOptions) ? next.oversOptions[0] : null;
      const slotsInFirst = first ? Math.round(first.minutes / (next.slotMinutes || 15)) : 1;
      next.oversPerSlot = first && slotsInFirst > 0 ? Math.round(first.overs / slotsInFirst) : 10;
      changed = true;
    }
    if (next.payAtVenueMaxOvers === undefined) {
      next.payAtVenueMaxOvers = 40;
      changed = true;
    }
    if (Array.isArray(next.ballTypes) && next.ballTypes.some((b: any) => b.pricePerSlot === undefined)) {
      next.ballTypes = next.ballTypes.map((b: any) => ({
        id: b.id,
        name: b.name,
        pricePerSlot: b.pricePerSlot ?? b.pricePerHour ?? 0,
      }));
      changed = true;
    }
  } else if (next.oversPerSlot === undefined || next.payAtVenueMaxOvers === undefined) {
    next.oversPerSlot = 0;
    next.payAtVenueMaxOvers = 0;
    next.ballTypes = [];
    changed = true;
  }

  if (next.weekendPriceRules === undefined) {
    // No weekend table at all is exactly what "one price all week" looks like, so
    // nothing an existing ground charges changes by filling this in.
    next.weekendPriceRules = [];
    changed = true;
  }
  if (next.weekendDays === undefined) {
    next.weekendDays = [5, 6, 0];
    changed = true;
  }

  if (next.oversOptions !== undefined) {
    delete next.oversOptions;
    changed = true;
  }

  return changed ? next : null;
}

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is not set. Copy .env.example to .env.local first.");

  if (process.env.NODE_ENV === "production" && !process.env.SEED_ALLOW_PRODUCTION) {
    throw new Error("Refusing to seed with NODE_ENV=production. Set SEED_ALLOW_PRODUCTION=1 if you really mean it.");
  }

  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(process.env.MONGODB_DB || "turf_booking");
  const now = new Date();

  for (const location of LOCATIONS) {
    const { facilities, ...fields } = location;
    const result = await db.collection("locations").findOneAndUpdate(
      { slug: location.slug },
      { $set: { active: true, ...fields, updatedAt: now }, $setOnInsert: { createdAt: now } },
      { upsert: true, returnDocument: "after" },
    );
    const locationId = result!._id as ObjectId;

    for (const [index, facility] of facilities.entries()) {
      const existing = await db.collection("facilities").findOne({ locationId, slug: facility.slug });
      const facilityId = existing?._id ?? new ObjectId();

      await db.collection("facilities").updateOne(
        { _id: facilityId },
        {
          $set: {
            locationId,
            name: facility.name,
            slug: facility.slug,
            kind: facility.kind,
            description: facility.description,
            sortOrder: index,
            active: true,
            updatedAt: now,
          },
          // Hours and prices are only written when the facility is new. A second
          // run must never undo an evening rate the owner has since set.
          $setOnInsert: { config: facility.config, createdAt: now },
        },
        { upsert: true },
      );

      for (const [order, resourceName] of facility.resources.entries()) {
        const slug = slugify(`${facility.slug}-${resourceName}`);
        await db.collection("resources").updateOne(
          { facilityId, slug },
          {
            $set: { locationId, facilityId, name: resourceName, sortOrder: order, active: true, updatedAt: now },
            $setOnInsert: { slug, createdAt: now },
          },
          { upsert: true },
        );
      }

      console.log(`  · ${facility.name} (${facility.resources.length} bookable)`);
    }

    console.log(`✓ ${location.name}`);
  }

  // Every facility, not just the seeded ones: a ground the owner added by hand
  // needs the same upgrade, and skipping it would leave that one broken.
  let upgraded = 0;
  for (const facility of await db.collection("facilities").find({}).toArray()) {
    const next = upgradeConfig(facility.config ?? {}, facility.kind === "OVERS" ? "OVERS" : "HOURLY");
    if (!next) continue;
    // The whole config object is replaced, so the retired `oversOptions` is gone
    // by virtue of not being in `next` — a separate $unset on the same path is
    // both redundant and a write conflict.
    await db.collection("facilities").updateOne({ _id: facility._id }, { $set: { config: next, updatedAt: now } });
    upgraded += 1;
  }
  if (upgraded > 0) console.log(`\nUpgraded ${upgraded} facility configuration(s) to the current pricing shape.`);

  console.log("\nAddresses and Google Maps links are blank — fill them in at Admin → Locations.");
  console.log("Next: npm run create-admin");
  await client.close();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
