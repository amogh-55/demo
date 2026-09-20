import { ObjectId } from "mongodb";
import { fail, ok, readJson } from "@/lib/api";
import { recordAudit, requireAdmin } from "@/lib/auth";
import { defaultConfigFor } from "@/lib/booking/service";
import { collections, getDb, isDuplicateKeyError } from "@/lib/db";
import { appError } from "@/lib/errors";
import { facilityCreateSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

/** The whole tree, for the admin screens that need to show it at once. */
export async function GET() {
  try {
    await requireAdmin();
    const db = await getDb();
    const [locations, facilities, resources] = await Promise.all([
      collections.locations(db).find({}).sort({ name: 1 }).toArray(),
      collections.facilities(db).find({}).sort({ sortOrder: 1, name: 1 }).toArray(),
      collections.resources(db).find({}).sort({ sortOrder: 1, name: 1 }).toArray(),
    ]);

    return ok({
      locations: locations.map((l) => ({ id: l._id.toHexString(), name: l.name, active: l.active })),
      facilities: facilities.map((f) => ({
        id: f._id.toHexString(),
        locationId: f.locationId.toHexString(),
        name: f.name,
        slug: f.slug,
        kind: f.kind,
        description: f.description,
        sortOrder: f.sortOrder,
        active: f.active,
        config: f.config,
      })),
      resources: resources.map((r) => ({
        id: r._id.toHexString(),
        locationId: r.locationId.toHexString(),
        facilityId: r.facilityId.toHexString(),
        name: r.name,
        slug: r.slug,
        sortOrder: r.sortOrder,
        active: r.active,
      })),
    });
  } catch (err) {
    return fail(err, { route: "GET /api/admin/facilities" });
  }
}

/**
 * Add a facility to a location, with a starting schedule for its kind.
 *
 * It also gets one resource straight away. A facility with nothing bookable under
 * it cannot be sold and is hidden from customers, so creating one without a
 * resource would look to the owner like the new facility simply did not appear.
 */
export async function POST(request: Request) {
  try {
    const admin = await requireAdmin();
    const input = facilityCreateSchema.parse(await readJson(request));

    const db = await getDb();
    const location = await collections.locations(db).findOne({ _id: input.locationId });
    if (!location) throw appError("NOT_FOUND", "That location does not exist.");

    const now = new Date();
    const _id = new ObjectId();
    const { locationId, ...rest } = input;

    try {
      await collections.facilities(db).insertOne({
        _id,
        locationId,
        ...rest,
        config: defaultConfigFor(input.kind),
        createdAt: now,
        updatedAt: now,
      });
      await collections.resources(db).insertOne({
        _id: new ObjectId(),
        locationId,
        facilityId: _id,
        name: input.name,
        slug: `${input.slug}-1`,
        sortOrder: 0,
        active: true,
        createdAt: now,
        updatedAt: now,
      });
    } catch (err) {
      if (isDuplicateKeyError(err)) throw appError("CONFLICT", "That location already has a facility with that slug.");
      throw err;
    }

    await recordAudit(admin, "FACILITY_CREATED", "facility", _id.toHexString(), {
      name: input.name,
      kind: input.kind,
      locationId: locationId.toHexString(),
    });
    return ok({ id: _id.toHexString() });
  } catch (err) {
    return fail(err, { route: "POST /api/admin/facilities" });
  }
}
