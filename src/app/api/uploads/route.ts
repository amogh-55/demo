import { cookies } from "next/headers";
import { fail, HOLD_COOKIE, LAST_BOOKING_COOKIE, ok, UPLOAD_FAILED_COOKIE } from "@/lib/api";
import { readSignedCookieValue } from "@/lib/auth";
import { getHold } from "@/lib/booking/service";
import { issueUploadFailureToken, UPLOAD_FAILURE_MAX_AGE } from "@/lib/booking/upload-failure";
import { collections, getDb } from "@/lib/db";
import { appError, isAppError } from "@/lib/errors";
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

    /**
     * What a storage failure would be an exemption FOR.
     *
     * Before the booking exists that is the hold; afterwards — a customer sending
     * a second screenshot for a balance — it is the booking reference. Either way
     * it is server-side state this request had to already possess, so the token
     * minted below cannot be carried over to anything else.
     */
    const exemptionSubject = hold && holdToken ? holdToken : lastBooking;

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

    try {
      const stored = await storePaymentScreenshot(file);
      // A successful upload retires any earlier failure, so a customer who
      // retries and succeeds is not left holding an exemption they do not need.
      jar.set(UPLOAD_FAILED_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
      return ok({ key: stored.key, size: stored.size, uploadStatus: "UPLOADED" });
    } catch (err) {
      /*
       * The one place the fallback is granted.
       *
       * UPLOAD_FAILED means the file was valid and the STORE refused it — a 5xx,
       * a timeout, a provider outage. Anything the customer got wrong arrives as
       * UPLOAD_INVALID and is rethrown untouched, so no amount of sending bad
       * files can talk the server into waiving the screenshot.
       */
      if (!isAppError(err) || err.code !== "UPLOAD_FAILED" || !exemptionSubject) throw err;

      jar.set(UPLOAD_FAILED_COOKIE, issueUploadFailureToken(exemptionSubject), {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        path: "/",
        maxAge: UPLOAD_FAILURE_MAX_AGE,
      });
      throw err;
    }
  } catch (err) {
    return fail(err, { route: "POST /api/uploads" });
  }
}
