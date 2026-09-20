/**
 * Development seed: three locations, operating hours and price bands.
 *
 * Deliberately creates NO bookings and NO customers — production must never be
 * polluted with fake demand. Running it twice is safe: locations are upserted by
 * slug and existing schedules are left alone.
 *
 *   npm run seed
 */
import { MongoClient, ObjectId } from "mongodb";
import { config as loadEnv } from "./env";

loadEnv();

const LOCATIONS = [
  {
    // Address confirmed from the business's Google Maps listing.
    name: "Spirit Cricket Zone — Medpally",
    slug: "medpally",
    address: "Medpally, Medipally Mandal, Medchal–Malkajgiri, Hyderabad, Telangana 500098",
    description: "Floodlit box-cricket turf open late, with parking on site.",
    image: "/images/floodlight-turf.jpg",
    phone: "7730825514",
  },
  {
    // Locality-level address only — replace with the exact street address in
    // Admin → Locations before sharing the site with customers.
    name: "Spirit Cricket Zone — Uppal",
    slug: "uppal",
    address: "Uppal, Hyderabad, Telangana 500039",
    description: "Floodlit turf near Uppal Ring Road, open from early morning.",
    image: "/images/box-cricket-turf.jpg",
    phone: "7730825514",
  },
  {
    // Locality-level address only — replace with the exact street address in
    // Admin → Locations before sharing the site with customers.
    name: "Spirit Cricket Zone — Gachibowli",
    slug: "gachibowli",
    address: "Gachibowli, Hyderabad, Telangana 500032",
    description: "Floodlit turf in the Financial District, open late on weekends.",
    image: "/images/cricket-sunset.jpg",
    phone: "7730825514",
  },
];

const SCHEDULE = {
  slotMinutes: 60,
  openMin: 6 * 60, // 6:00 AM
  closeMin: 23 * 60, // 11:00 PM
  bookingWindowDays: 30,
  holdMinutes: 10,
  priceRules: [
    { fromMin: 6 * 60, toMin: 12 * 60, price: 700 }, // mornings
    { fromMin: 12 * 60, toMin: 17 * 60, price: 800 }, // afternoons
    { fromMin: 17 * 60, toMin: 23 * 60, price: 1200 }, // prime evening
  ],
};

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is not set. Copy .env.example to .env.local first.");

  if (process.env.NODE_ENV === "production" && !process.env.SEED_ALLOW_PRODUCTION) {
    throw new Error("Refusing to seed with NODE_ENV=production. Set SEED_ALLOW_PRODUCTION=1 if you really mean it.");
  }

  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(process.env.MONGODB_DB || "turf_booking");

  for (const location of LOCATIONS) {
    const now = new Date();
    const result = await db.collection("locations").findOneAndUpdate(
      { slug: location.slug },
      { $set: { active: true, ...location, updatedAt: now }, $setOnInsert: { createdAt: now } },
      { upsert: true, returnDocument: "after" },
    );

    const locationId = result?._id as ObjectId;
    await db
      .collection("slotConfigurations")
      .updateOne(
        { locationId },
        { $setOnInsert: { locationId, ...SCHEDULE, updatedAt: now } },
        { upsert: true },
      );

    console.log(`✓ ${location.name}`);
  }

  console.log("\nSeeded 3 locations with hours 6:00 AM – 11:00 PM and three price bands.");
  console.log("Next: npm run create-admin");
  await client.close();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
