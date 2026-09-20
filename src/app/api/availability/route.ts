import { fail, ok } from "@/lib/api";
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
      locationId: url.searchParams.get("locationId") ?? "",
      date: url.searchParams.get("date") ?? "",
    });

    const availability = await getAvailability(input.locationId, input.date);
    return ok(availability, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return fail(err, { route: "GET /api/availability" });
  }
}
