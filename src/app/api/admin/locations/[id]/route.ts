import { revalidatePath } from "next/cache";
import { ObjectId } from "mongodb";
import { fail, ok, readJson } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { forgetResourceContext } from "@/lib/booking/service";
import { collections, getDb } from "@/lib/db";
import { appError } from "@/lib/errors";
import { locationUpdateSchema } from "@/lib/validation";

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

    // The cached resource context still describes this as it was, so it is
    // dropped now the write has landed — the owner sees their own edit at
    // once rather than whenever the short TTL happens to lapse.
    forgetResourceContext();
    revalidatePath("/"); // the home page advertises this
    return ok({ location: { id: updated._id.toHexString(), name: updated.name, active: updated.active } });
  } catch (err) {
    return fail(err, { route: "PATCH /api/admin/locations/[id]" });
  }
}

/**
 * Hours and pricing live on the FACILITY now, not the location: a ground can
 * sell hourly turf and 15-minute bowling side by side, and those cannot share one
 * schedule. See PUT /api/admin/facilities/[id].
 */
