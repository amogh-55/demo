import { ObjectId } from "mongodb";
import { fail, ok, readJson } from "@/lib/api";
import { recordAudit, requireAdmin } from "@/lib/auth";
import { collections, getDb, isDuplicateKeyError } from "@/lib/db";
import { appError } from "@/lib/errors";
import { locationCreateSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await requireAdmin();
    const db = await getDb();
    const locations = await collections.locations(db).find({}).sort({ name: 1 }).toArray();

    return ok({
      locations: locations.map((l) => ({
        id: l._id.toHexString(),
        name: l.name,
        slug: l.slug,
        address: l.address,
        mapsUrl: l.mapsUrl ?? "",
        description: l.description,
        image: l.image,
        phone: l.phone,
        active: l.active,
      })),
    });
  } catch (err) {
    return fail(err, { route: "GET /api/admin/locations" });
  }
}

export async function POST(request: Request) {
  try {
    const admin = await requireAdmin();
    const input = locationCreateSchema.parse(await readJson(request));

    const db = await getDb();
    const now = new Date();
    const _id = new ObjectId();

    try {
      await collections.locations(db).insertOne({ _id, ...input, createdAt: now, updatedAt: now });
    } catch (err) {
      if (isDuplicateKeyError(err)) throw appError("CONFLICT", "A location with that slug already exists.");
      throw err;
    }

    // No facility is created here: what a ground sells differs per ground, so the
    // owner adds the box, the nets or the courts themselves. Until they do, the
    // location has nothing bookable and is hidden from customers rather than
    // offered as an empty page.
    await recordAudit(admin, "LOCATION_CREATED", "location", _id.toHexString(), { name: input.name });
    return ok({ id: _id.toHexString() });
  } catch (err) {
    return fail(err, { route: "POST /api/admin/locations" });
  }
}
