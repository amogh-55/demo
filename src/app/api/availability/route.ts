import { fail, ok } from "@/lib/api";
import { reclaimAbandonedOnlinePayments } from "@/lib/booking/online-payment";
import { getAvailability } from "@/lib/booking/service";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import { availabilityQuerySchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

/**
 * Public availability. Returns slot state and price only — never customer names,
 * phone numbers or other people's booking references.
 */
export async function GET(request: Request) {
  try {
    await rateLimit(`availability:${clientIp(request.headers)}`, 240, 60);

    const url = new URL(request.url);
    const input = availabilityQuerySchema.parse({
      resourceId: url.searchParams.get("resourceId") ?? "",
      date: url.searchParams.get("date") ?? "",
    });

    /*
     * Give back the slots of anyone who opened checkout and walked away, before
     * reading the day rather than after.
     *
     * This is where it belongs because this is who needs it: the next customer,
     * looking at the grid. The open booking page re-reads availability every
     * twenty seconds, so an abandoned slot comes back on sale by itself within a
     * few seconds of its deadline, with no scheduled job and no admin involved.
     * It does nothing at all — one indexed query returning nothing — on every day
     * where nobody abandoned anything, which is almost all of them.
     */
    await reclaimAbandonedOnlinePayments({ resourceId: input.resourceId, date: input.date });

    const availability = await getAvailability(input.resourceId, input.date);
    return ok(availability, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return fail(err, { route: "GET /api/availability" });
  }
}
