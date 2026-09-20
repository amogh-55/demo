import { fail, ok } from "@/lib/api";
import { getPublicCatalog } from "@/lib/catalog";

export const dynamic = "force-dynamic";

/**
 * Public catalogue: locations, the facilities at each, and the bookable
 * resources under those. Nothing here is customer data.
 */
export async function GET() {
  try {
    return ok({ locations: await getPublicCatalog() });
  } catch (err) {
    return fail(err, { route: "GET /api/locations" });
  }
}
