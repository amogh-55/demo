/**
 * Clears booking data and the pre-facility location records, so `npm run seed`
 * can lay down the new Location → Facility → Resource structure cleanly.
 *
 *   CONFIRM_RESET=yes npm run reset-bookings
 *
 * DESTRUCTIVE. It deletes every booking, every reserved slot and every block.
 * Run it once, while the only bookings in the database are test ones, and never
 * again after a real customer has paid for something.
 *
 * Admin accounts, settings and the audit log are left alone.
 */
import { MongoClient } from "mongodb";
import { config as loadEnv } from "./env";

loadEnv();

/** Slugs from the single-facility version of the app, replaced by the new grounds. */
const LEGACY_LOCATION_SLUGS = ["medpally", "uppal", "gachibowli"];

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is not set.");

  if (process.env.CONFIRM_RESET !== "yes") {
    console.error("Refusing to run. This deletes every booking. Re-run with CONFIRM_RESET=yes if you mean it.");
    process.exit(1);
  }

  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(process.env.MONGODB_DB || "turf_booking");

  const bookings = await db.collection("bookings").countDocuments();
  console.log(`Deleting ${bookings} booking(s) and everything reserved for them.`);

  for (const name of ["bookings", "slotUnits", "dayBlocks", "slotConfigurations"]) {
    const { deletedCount } = await db.collection(name).deleteMany({});
    console.log(`  ${name}: ${deletedCount} removed`);
  }

  const legacy = await db.collection("locations").deleteMany({ slug: { $in: LEGACY_LOCATION_SLUGS } });
  console.log(`  locations: ${legacy.deletedCount} legacy ground(s) removed`);

  // The old unique indexes are keyed on locationId and would enforce one booking
  // per ground-hour across every court and machine. They are rebuilt on the new
  // keys by the app itself the next time it connects.
  for (const [collection, index] of [
    ["slotUnits", "slot_unit_identity"],
    ["dayBlocks", "locationId_1_date_1"],
  ] as const) {
    await db
      .collection(collection)
      .dropIndex(index)
      .then(() => console.log(`  ${collection}: dropped ${index}`))
      .catch(() => {});
  }

  console.log("\nDone. Next: npm run seed");
  await client.close();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
