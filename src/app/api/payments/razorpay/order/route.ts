import { cookies } from "next/headers";
import { fail, LAST_BOOKING_COOKIE, ok } from "@/lib/api";
import { readSignedCookieValue } from "@/lib/auth";
import { releaseUnpaidOnlineBooking, startOnlinePayment } from "@/lib/booking/online-payment";
import { collections, getDb } from "@/lib/db";
import { appError } from "@/lib/errors";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import { razorpayConfigured } from "@/lib/razorpay";
import { getSettings } from "@/lib/settings";
import { formatCompactRange } from "@/lib/time";

export const dynamic = "force-dynamic";

/**
 * Raise the charge for the caller's own booking.
 *
 * Takes no request body at all, which is the point: there is nothing here a
 * client could tamper with. Which booking is decided by a signed httpOnly cookie
 * this server minted when the booking was made, and how much is decided by that
 * booking's own stored figures. A browser cannot ask to pay for somebody else's
 * slot, and it cannot ask to pay less for its own.
 *
 * Safe to call repeatedly. Pressing pay twice reopens the same Razorpay order
 * rather than raising a second charge, and a booking that has already been paid
 * for comes back saying so instead of being charged again.
 */
export async function POST(request: Request) {
  try {
    await rateLimit(`rzp-order:${clientIp(request.headers)}`, 20, 60);

    const jar = await cookies();
    const reference = readSignedCookieValue(jar.get(LAST_BOOKING_COOKIE)?.value);
    if (!reference) throw appError("NOT_FOUND", "We could not find your booking on this device.");

    // Both halves are checked on every request: the keys have to be deployed AND
    // the owner has to have switched online payment on. Either being false sends
    // the customer to the UPI flow rather than into a checkout that cannot work.
    const settings = await getSettings();
    if (!razorpayConfigured() || !settings.razorpayEnabled) {
      throw appError("CONFLICT", "Online payment is not available right now. Please pay by UPI instead.");
    }

    const db = await getDb();
    const booking = await collections.bookings(db).findOne({ reference });
    if (!booking) throw appError("NOT_FOUND", "We could not find your booking.");

    const result = await startOnlinePayment(booking);
    if (result.kind === "ALREADY_PAID") {
      return ok({ alreadyPaid: true, reference: booking.reference, status: result.booking.status });
    }

    return ok({
      alreadyPaid: false,
      ...result.order,
      businessName: settings.businessName,
      description: `${booking.facilityName} · ${booking.date} ${formatCompactRange(booking.startMin, booking.endMin)}`,
      // Saves the customer retyping what they have already told us. Razorpay
      // treats these as suggestions; the amount is not among them.
      prefill: {
        name: booking.customerName,
        contact: `+91${booking.customerPhone}`,
        email: booking.customerEmail ?? "",
      },
    });
  } catch (err) {
    return fail(err, { route: "POST /api/payments/razorpay/order" });
  }
}

/**
 * Give back the caller's own unpaid online booking: they pressed Change slot.
 *
 * Same cookie, same rule as above — a browser can only ever let go of the booking
 * it made, and only while nothing has been paid on it. If Razorpay says the money
 * did arrive, the booking is confirmed instead and the answer says so, so the page
 * shows the customer their booking rather than sending them off to pay again.
 */
export async function DELETE(request: Request) {
  try {
    await rateLimit(`rzp-release:${clientIp(request.headers)}`, 20, 60);

    const jar = await cookies();
    const reference = readSignedCookieValue(jar.get(LAST_BOOKING_COOKIE)?.value);
    // The page names the booking it is walking away from. With two tabs open the
    // cookie can already point at the other tab's booking, and that one is left
    // alone — this one goes back on sale with the sweep instead.
    const claimed = new URL(request.url).searchParams.get("reference");
    if (!reference || reference !== claimed) return ok({ released: false, alreadyPaid: false });

    const db = await getDb();
    const booking = await collections.bookings(db).findOne({ reference });
    if (!booking) return ok({ released: false, alreadyPaid: false });

    const after = await releaseUnpaidOnlineBooking(booking);
    if (after.status === "CONFIRMED") {
      return ok({ released: false, alreadyPaid: true, reference: after.reference });
    }
    return ok({ released: after.status !== "PENDING", alreadyPaid: false });
  } catch (err) {
    return fail(err, { route: "DELETE /api/payments/razorpay/order" });
  }
}
