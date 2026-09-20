import { ObjectId } from "mongodb";
import { fail, ok, readJson } from "@/lib/api";
import { recordAudit, requireAdmin } from "@/lib/auth";
import { collections, getDb } from "@/lib/db";
import { appError } from "@/lib/errors";
import { locationUpdateSchema, slotConfigSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

function parseId(raw: string): ObjectId {
  if (!ObjectId.isValid(raw)) throw appError("NOT_FOUND", "That location does not exist.");
  return new ObjectId(raw);
}

/**
 * Update a location. Deactivating one stops NEW bookings only — existing bookings
 * and their history are never touched, let alone deleted.
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const admin = await requireAdmin();
    const id = parseId((await params).id);
    const patch = locationUpdateSchema.parse(await readJson(request));
    if (Object.keys(patch).length === 0) throw appError("VALIDATION", "Nothing to update.");

    const db = await getDb();
    const updated = await collections
      .locations(db)
      .findOneAndUpdate({ _id: id }, { $set: { ...patch, updatedAt: new Date() } }, { returnDocument: "after" });
    if (!updated) throw appError("NOT_FOUND", "That location does not exist.");

    await recordAudit(admin, "LOCATION_UPDATED", "location", id.toHexString(), { fields: Object.keys(patch) });
    return ok({ location: { id: updated._id.toHexString(), name: updated.name, active: updated.active } });
  } catch (err) {
    return fail(err, { route: "PATCH /api/admin/locations/[id]" });
  }
}

/** Operating hours, slot length, prices, booking window and hold duration. */
export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const admin = await requireAdmin();
    const id = parseId((await params).id);
    const config = slotConfigSchema.parse(await readJson(request));

    const db = await getDb();
    const location = await collections.locations(db).findOne({ _id: id });
    if (!location) throw appError("NOT_FOUND", "That location does not exist.");

    await collections.slotConfigs(db).updateOne(
      { locationId: id },
      { $set: { ...config, updatedAt: new Date() }, $setOnInsert: { locationId: id } },
      { upsert: true },
    );

    // Existing bookings keep their price snapshot; only future pricing changes.
    await recordAudit(admin, "PRICE_CHANGED", "location", id.toHexString(), {
      openMin: config.openMin,
      closeMin: config.closeMin,
      slotMinutes: config.slotMinutes,
      priceRules: config.priceRules,
    });

    return ok({ saved: true });
  } catch (err) {
    return fail(err, { route: "PUT /api/admin/locations/[id]" });
  }
}
