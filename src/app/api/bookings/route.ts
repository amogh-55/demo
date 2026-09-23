import { cookies } from "next/headers";
import { fail, HOLD_COOKIE, LAST_BOOKING_COOKIE, ok, readJson, UPLOAD_FAILED_COOKIE } from "@/lib/api";
import { signCookieValue } from "@/lib/auth";
import { submitBooking } from "@/lib/booking/service";
import { uploadFailureProven } from "@/lib/booking/upload-failure";
import { appError } from "@/lib/errors";
import { OTP_COOKIE, readVerifiedPhone } from "@/lib/otp";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import { razorpayConfigured } from "@/lib/razorpay";
import { getSettings } from "@/lib/settings";
import { notifyNewBooking } from "@/lib/sms";
import { formatBusinessDate, formatCompactRange } from "@/lib/time";
import { bookingSubmitSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

/**
 * Turn a live hold into a PENDING booking.
 *
 * The client supplies only a name, a phone number, the UPI reference it paid with
 * and the storage key of its screenshot, if that uploaded. Location, date, time
 * and amount all come from the server-side hold, so a tampered request cannot
 * change what is being booked or what it costs.
 */
export async function POST(request: Request) {
  try {
    await rateLimit(`booking:${clientIp(request.headers)}`, 30, 60);

    const body = (await readJson(request)) as Record<string, unknown>;
    const jar = await cookies();
    const cookieToken = jar.get(HOLD_COOKIE)?.value;

    // The cookie is authoritative; the body token is a fallback for clients that
    // lost the cookie. Either way the token itself proves ownership of the hold.
    const input = bookingSubmitSchema.parse({ ...body, holdToken: cookieToken ?? body.holdToken });
    if (cookieToken && body.holdToken && body.holdToken !== cookieToken) {
      throw appError("HOLD_INVALID");
    }

    // Whether verification is required is read from the database on every
    // request, so flipping the switch in Admin → Settings takes effect at once
    // and a client cannot opt itself out by omitting a field.
    const settings = await getSettings();
    const verifiedPhone = readVerifiedPhone(jar.get(OTP_COOKIE)?.value);

    /*
     * Whether this booking may skip the UTR and the screenshot is decided HERE,
     * from the server's own keys and the owner's own switch — never from the body.
     * A client that asks for the gateway while it is unavailable is refused
     * outright rather than quietly downgraded, which would leave the customer
     * looking at a demand for a payment reference nobody asked them to produce.
     */
    const gatewayReady = razorpayConfigured() && settings.razorpayEnabled;
    if (input.paymentMethod === "RAZORPAY" && !gatewayReady) {
      throw appError(
        "CONFLICT",
        "Online card/UPI payment is not available right now. Please pay by UPI and upload a screenshot instead.",
      );
    }

    const booking = await submitBooking({
      holdToken: input.holdToken,
      customerName: input.customerName,
      customerPhone: input.customerPhone,
      paymentScreenshotKey: input.paymentScreenshotKey,
      utr: input.utr,
      payAdvance: input.payAdvance,
      paymentMethod: input.paymentMethod === "RAZORPAY" ? "RAZORPAY" : "UPI_MANUAL",
      customerEmail: input.customerEmail,
      verifiedPhone,
      requirePhoneVerification: settings.otpEnabled,
      /*
       * Read from a cookie this server signed, never from the request body. It
       * is the only thing that lets a booking through without a screenshot, so
       * a client asserting it would be a client waiving the requirement.
       */
      storageFailed: uploadFailureProven(jar.get(UPLOAD_FAILED_COOKIE)?.value, input.holdToken),
    });

    /*
     * A gateway booking has not been paid for yet and may never be, so the owner
     * is told about it when the money lands rather than when the form was
     * submitted — the settle path sends this same alert. Texting them about a
     * booking that evaporates in fifteen minutes costs them money and trust in
     * the alert.
     */
    if (settings.notifyOnNewBooking && booking.paymentMethod !== "RAZORPAY") {
      notifyNewBooking(settings.notifyPhone || settings.supportPhone, {
        reference: booking.reference,
        customerName: booking.customerName,
        locationName: booking.locationName,
        facilityName: booking.facilityName,
        when: `${formatBusinessDate(booking.date)} ${formatCompactRange(booking.startMin, booking.endMin)}`,
        amount: booking.amount,
      });
    }

    // Remember the finished booking for the success page and any balance payment...
    jar.set(LAST_BOOKING_COOKIE, signCookieValue(booking.reference), {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 7,
    });
    // ...and drop the hold cookie, so the customer can immediately book again.
    jar.set(HOLD_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
    // The exemption belonged to this hold and is spent. Leaving it would let the
    // next booking from this browser skip its screenshot too.
    jar.set(UPLOAD_FAILED_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });

    return ok({
      reference: booking.reference,
      status: booking.status,
      locationName: booking.locationName,
      facilityName: booking.facilityName,
      resourceName: booking.resourceName,
      date: booking.date,
      startMin: booking.startMin,
      endMin: booking.endMin,
      overs: booking.overs,
      ballTypeName: booking.ballTypeName,
      amount: booking.amount,
      amountDueNow: booking.amountDueNow ?? booking.amount,
      customerPhone: booking.customerPhone,
      // The browser needs to know whether to open checkout next, or whether the
      // booking is already finished with (a pay-at-the-ground session).
      paymentMethod: booking.paymentMethod ?? null,
    });
  } catch (err) {
    return fail(err, { route: "POST /api/bookings" });
  }
}
