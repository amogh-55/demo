import { cookies } from "next/headers";
import { fail, HOLD_COOKIE, ok, readJson } from "@/lib/api";
import { createHold, getHold, releaseHold } from "@/lib/booking/service";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import { holdRequestSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

const HOLD_COOKIE_MAX_AGE = 60 * 60; // outlives the hold itself so expiry can be explained

/**
 * Reserve a slot range. The raw hold token is returned once and also stored in an
 * httpOnly cookie, which is what lets a refresh or a back navigation recover the
 * same hold instead of creating a second one.
 */
export async function POST(request: Request) {
  try {
    await rateLimit(`hold:${clientIp(request.headers)}`, 60, 60);

    const input = holdRequestSchema.parse(await readJson(request));
    const jar = await cookies();

    // Re-picking a slot gives the previous one back immediately rather than
    // leaving it parked until it expires.
    const previous = jar.get(HOLD_COOKIE)?.value;
    if (previous) await releaseHold(previous);

    const hold = await createHold(input);

    jar.set(HOLD_COOKIE, hold.holdToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: HOLD_COOKIE_MAX_AGE,
    });

    return ok({
      holdUntil: hold.holdUntil.toISOString(),
      locationId: hold.locationId,
      locationName: hold.locationName,
      date: hold.date,
      startMin: hold.startMin,
      endMin: hold.endMin,
      amount: hold.amount,
      breakdown: hold.breakdown,
    });
  } catch (err) {
    return fail(err, { route: "POST /api/holds" });
  }
}

/** Recover the caller's own hold. Reads the token from the cookie, never the URL. */
export async function GET() {
  try {
    const token = (await cookies()).get(HOLD_COOKIE)?.value;
    if (!token) return ok({ hold: null });

    const hold = await getHold(token);
    if (!hold) return ok({ hold: null });

    return ok({
      hold: {
        holdUntil: hold.holdUntil.toISOString(),
        locationId: hold.locationId,
        locationName: hold.locationName,
        date: hold.date,
        startMin: hold.startMin,
        endMin: hold.endMin,
        amount: hold.amount,
        breakdown: hold.breakdown,
        submittedBookingReference: hold.submittedBookingReference,
      },
    });
  } catch (err) {
    return fail(err, { route: "GET /api/holds" });
  }
}

export async function DELETE() {
  try {
    const jar = await cookies();
    const token = jar.get(HOLD_COOKIE)?.value;
    if (token) await releaseHold(token);
    jar.set(HOLD_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
    return ok({ released: true });
  } catch (err) {
    return fail(err, { route: "DELETE /api/holds" });
  }
}
