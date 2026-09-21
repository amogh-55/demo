import { cookies } from "next/headers";
import { fail, LAST_BOOKING_COOKIE, ok, readJson, UPLOAD_FAILED_COOKIE } from "@/lib/api";
import { readSignedCookieValue } from "@/lib/auth";
import { addPaymentAttempt } from "@/lib/booking/service";
import { uploadFailureProven } from "@/lib/booking/upload-failure";
import { collections, getDb } from "@/lib/db";
import { appError } from "@/lib/errors";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import { addPaymentSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

/**
 * Send another payment screenshot for a booking that is still short.
 *
 * Ownership comes from the same hold cookie that created the booking, so nobody
 * can attach a payment to someone else's booking. The customer never states an
 * amount — the admin reads it off the image, or off the statement line the UTR
 * points at — so nothing here is client-priced.
 */
export async function POST(request: Request) {
  try {
    await rateLimit(`balance:${clientIp(request.headers)}`, 20, 60);

    const jar = await cookies();
    const reference = readSignedCookieValue(jar.get(LAST_BOOKING_COOKIE)?.value);
    if (!reference) throw appError("NOT_FOUND", "We could not find your booking on this device.");

    const input = addPaymentSchema.parse(await readJson(request));

    const db = await getDb();
    const booking = await collections.bookings(db).findOne({ reference });
    if (!booking) throw appError("NOT_FOUND", "We could not find your booking.");

    const updated = await addPaymentAttempt({
      bookingId: booking._id,
      screenshotKey: input.paymentScreenshotKey,
      // Once the booking exists there is no hold left, so the reference stands in
      // as the thing the exemption is bound to. Still signed by this server and
      // still issued only by the upload route after a genuine store failure.
      storageFailed: uploadFailureProven(jar.get(UPLOAD_FAILED_COOKIE)?.value, reference),
      utr: input.utr,
    });

    return ok({
      reference: updated.reference,
      amount: updated.amount,
      amountPaid: updated.amountPaid,
      amountRemaining: Math.max(0, updated.amount - updated.amountPaid),
      paymentVerificationStatus: updated.paymentVerificationStatus,
    });
  } catch (err) {
    return fail(err, { route: "POST /api/bookings/payments" });
  }
}
