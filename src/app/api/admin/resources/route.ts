import { ObjectId } from "mongodb";
import { fail, ok, readJson } from "@/lib/api";
import { recordAudit, requireAdmin } from "@/lib/auth";
import { collections, getDb, isDuplicateKeyError } from "@/lib/db";
import { appError } from "@/lib/errors";
import { resourceCreateSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

/**
 * Add a bookable resource — a second pickleball court, another net, a second
 * machine. It inherits the facility's hours and prices, and gets its own
 * availability and its own lock the moment it exists.
 */
export async function POST(request: Request) {
  try {
    const admin = await requireAdmin();
    const input = resourceCreateSchema.parse(await readJson(request));

    const db = await getDb();
    const facility = await collections.facilities(db).findOne({ _id: input.facilityId });
    if (!facility) throw appError("NOT_FOUND", "That facility does not exist.");

    const now = new Date();
    const _id = new ObjectId();
    try {
      await collections.resources(db).insertOne({
        _id,
        locationId: facility.locationId,
        facilityId: facility._id,
        name: input.name,
        slug: input.slug,
        sortOrder: input.sortOrder,
        active: input.active,
        createdAt: now,
        updatedAt: now,
      });
    } catch (err) {
      if (isDuplicateKeyError(err)) throw appError("CONFLICT", "That facility already has one with that slug.");
      throw err;
    }

    await recordAudit(admin, "RESOURCE_CREATED", "resource", _id.toHexString(), {
      name: input.name,
      facilityId: facility._id.toHexString(),
    });
    return ok({ id: _id.toHexString() });
  } catch (err) {
    return fail(err, { route: "POST /api/admin/resources" });
  }
}
