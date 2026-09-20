import { collections, getDb } from "@/lib/db";
import { fail, ok } from "@/lib/api";

export const dynamic = "force-dynamic";

/** Public list of bookable locations. Nothing here is customer data. */
export async function GET() {
  try {
    const db = await getDb();
    const locations = await collections
      .locations(db)
      .find({ active: true }, { projection: { name: 1, slug: 1, address: 1, description: 1, image: 1, phone: 1 } })
      .sort({ name: 1 })
      .toArray();

    return ok({
      locations: locations.map((l) => ({
        id: l._id.toHexString(),
        name: l.name,
        slug: l.slug,
        address: l.address,
        description: l.description,
        image: l.image,
        phone: l.phone,
      })),
    });
  } catch (err) {
    return fail(err, { route: "GET /api/locations" });
  }
}
