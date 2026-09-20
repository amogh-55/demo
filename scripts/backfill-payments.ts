/**
 * One-off migration for bookings taken before payment attempts existed.
 *
 * Those documents have a single `paymentScreenshotKey` but no `payments` array and
 * no `amountPaid`, which leaves them stuck: the review dialog finds no attempt to
 * act on, so the admin can neither record the money nor confirm the booking. The
 * only way out was to reject the customer.
 *
 * This rebuilds one PENDING attempt from the screenshot the customer did send, so
 * the booking rejoins the normal flow. It never invents a payment: `amount` stays
 * null until an admin reads the screenshot, exactly as for a new booking.
 *
 *   npm run backfill-payments -- --dry-run
 *   npm run backfill-payments
 */
import crypto from "node:crypto";
import { MongoClient } from "mongodb";
import { config as loadEnv } from "./env";

loadEnv();

const DRY_RUN = process.argv.includes("--dry-run");

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is not set");

  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(process.env.MONGODB_DB || "turf_booking");
  const bookings = db.collection("bookings");

  const legacy = await bookings.find({ payments: { $in: [null, []] } }).toArray();
  console.log(`bookings without a payments array: ${legacy.length}`);

  let repaired = 0;
  for (const booking of legacy as any[]) {
    const key = booking.paymentScreenshotKey;
    const uploadedAt = booking.paymentUploadedAt ?? booking.createdAt ?? new Date();

    // A rejected booking keeps its verdict; anything still open goes back to PENDING
    // so the admin can act on it.
    const alreadyDecided = booking.paymentVerificationStatus === "REJECTED";

    const attempts = key
      ? [
          {
            id: crypto.randomUUID(),
            screenshotKey: key,
            uploadedAt,
            amount: null,
            status: alreadyDecided ? "REJECTED" : "PENDING",
            reviewedBy: alreadyDecided ? "migration" : null,
            reviewedAt: alreadyDecided ? new Date() : null,
            note: alreadyDecided ? "Reviewed before payment attempts were recorded" : null,
          },
        ]
      : [];

    console.log(
      `  ${booking.reference}  ${booking.status}/${booking.paymentVerificationStatus}  ` +
        `→ ${attempts.length} attempt(s), amountPaid ${booking.amountPaid ?? 0}`,
    );

    if (!DRY_RUN) {
      await bookings.updateOne(
        { _id: booking._id },
        { $set: { payments: attempts, amountPaid: booking.amountPaid ?? 0, updatedAt: new Date() } },
      );
      repaired += 1;
    }
  }

  // `amountPaid` missing on its own breaks the outstanding-balance arithmetic.
  const missingTotal = await bookings.updateMany(
    { amountPaid: { $exists: false } },
    { $set: { amountPaid: 0 } },
  );

  console.log(
    DRY_RUN
      ? "\nDRY RUN — nothing written. Re-run without --dry-run to apply."
      : `\nrepaired ${repaired} booking(s); set amountPaid on ${missingTotal.modifiedCount} more`,
  );

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
