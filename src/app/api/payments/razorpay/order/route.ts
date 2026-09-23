import { cookies } from "next/headers";
import { fail, LAST_BOOKING_COOKIE, ok } from "@/lib/api";
import { readSignedCookieValue } from "@/lib/auth";
import { startOnlinePayment } from "@/lib/booking/online-payment";
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
