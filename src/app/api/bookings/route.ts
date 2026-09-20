import { cookies } from "next/headers";
import { fail, HOLD_COOKIE, LAST_BOOKING_COOKIE, ok, readJson } from "@/lib/api";
import { signCookieValue } from "@/lib/auth";
import { submitBooking } from "@/lib/booking/service";
import { appError } from "@/lib/errors";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import { bookingSubmitSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

/**
 * Turn a live hold into a PENDING booking.
 *
 * The client supplies only a name, a phone number and the storage key of its
 * screenshot. Location, date, time and amount all come from the server-side hold,
 * so a tampered request cannot change what is being booked or what it costs.
 */
export async function POST(request: Request) {
  try {
    await rateLimit(`booking:${clientIp(request.headers)}`, 30, 60);

    const body = (await readJson(request)) as Record<string, unknown>;
    const cookieToken = (await cookies()).get(HOLD_COOKIE)?.value;

    // The cookie is authoritative; the body token is a fallback for clients that
    // lost the cookie. Either way the token itself proves ownership of the hold.
    const input = bookingSubmitSchema.parse({ ...body, holdToken: cookieToken ?? body.holdToken });
    if (cookieToken && body.holdToken && body.holdToken !== cookieToken) {
      throw appError("HOLD_INVALID");
    }

    const booking = await submitBooking({
      holdToken: input.holdToken,
      customerName: input.customerName,
      customerPhone: input.customerPhone,
      paymentScreenshotKey: input.paymentScreenshotKey,
    });

    const jar = await cookies();
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

    return ok({
      reference: booking.reference,
      status: booking.status,
      locationName: booking.locationName,
      date: booking.date,
      startMin: booking.startMin,
      endMin: booking.endMin,
      amount: booking.amount,
      customerPhone: booking.customerPhone,
    });
  } catch (err) {
    return fail(err, { route: "POST /api/bookings" });
  }
}
