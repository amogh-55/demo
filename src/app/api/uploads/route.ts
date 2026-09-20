import { cookies } from "next/headers";
import { fail, HOLD_COOKIE, LAST_BOOKING_COOKIE, ok } from "@/lib/api";
import { readSignedCookieValue } from "@/lib/auth";
import { getHold } from "@/lib/booking/service";
import { collections, getDb } from "@/lib/db";
import { appError } from "@/lib/errors";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import { MAX_UPLOAD_BYTES, storePaymentScreenshot } from "@/lib/storage";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Accepts the payment screenshot and returns an opaque storage key. Requires a
 * live hold, so the bucket cannot be used as free anonymous storage. The file is
 * validated by magic bytes, not by the Content-Type the browser claims.
 */
export async function POST(request: Request) {
  try {
    await rateLimit(`upload:${clientIp(request.headers)}`, 30, 60);

    // Two legitimate reasons to upload: a slot is held for a booking in progress,
    // or a submitted booking still owes money and needs another screenshot.
    const jar = await cookies();
    const holdToken = jar.get(HOLD_COOKIE)?.value;
    const lastBooking = readSignedCookieValue(jar.get(LAST_BOOKING_COOKIE)?.value);

    const hold = holdToken ? await getHold(holdToken) : null;
    if (!hold) {
      if (!lastBooking) throw appError("HOLD_EXPIRED");
      const db = await getDb();
      const booking = await collections
        .bookings(db)
        .findOne({ reference: lastBooking }, { projection: { status: 1, paymentVerificationStatus: 1 } });
      const owesMore =
        booking?.status === "PENDING" &&
        ["PENDING", "PARTIAL", "REJECTED"].includes(booking.paymentVerificationStatus);
      if (!owesMore) throw appError("HOLD_EXPIRED");
    }

    // A browser always declares the length of a FormData upload. Insisting on it
    // means an unbounded chunked body is refused before it is read into memory,
    // rather than after.
    const declared = request.headers.get("content-length");
    const contentLength = Number(declared);
    if (!declared || !Number.isFinite(contentLength) || contentLength <= 0) {
      throw appError("UPLOAD_INVALID", "Please choose a screenshot to upload.");
    }
    if (contentLength > MAX_UPLOAD_BYTES * 1.1) {
      throw appError("UPLOAD_INVALID", "That image is larger than 5MB. Please upload a smaller screenshot.");
    }

    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      // Not multipart, or truncated mid-upload: a bad request, not a server fault.
      throw appError("UPLOAD_INVALID", "That upload could not be read. Please choose the screenshot again.");
    }

    const file = form.get("file");
    if (!(file instanceof File)) throw appError("UPLOAD_INVALID", "Please choose a screenshot to upload.");

    const stored = await storePaymentScreenshot(file);
    return ok({ key: stored.key, size: stored.size });
  } catch (err) {
    return fail(err, { route: "POST /api/uploads" });
  }
}
