import { ObjectId } from "mongodb";
import { fail, ok, readJson } from "@/lib/api";
import { recordAudit, requireAdmin } from "@/lib/auth";
import { collections, getDb } from "@/lib/db";
import { appError } from "@/lib/errors";
import { resourceUpdateSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

/**
 * Rename a court, reorder it, or take it out of service.
 *
 * There is no delete. A resource is what every slot unit and every booking points
 * at, so removing one would orphan a paying customer's record. Deactivating stops
 * new bookings and leaves the history intact, which is what "remove" actually
 * means here.
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const admin = await requireAdmin();
    const raw = (await params).id;
    if (!ObjectId.isValid(raw)) throw appError("NOT_FOUND", "That court does not exist.");
    const id = new ObjectId(raw);

    const patch = resourceUpdateSchema.parse(await readJson(request));
    if (Object.keys(patch).length === 0) throw appError("VALIDATION", "Nothing to update.");

    const db = await getDb();
    const updated = await collections
      .resources(db)
      .findOneAndUpdate({ _id: id }, { $set: { ...patch, updatedAt: new Date() } }, { returnDocument: "after" });
    if (!updated) throw appError("NOT_FOUND", "That court does not exist.");

    await recordAudit(admin, "RESOURCE_UPDATED", "resource", id.toHexString(), { fields: Object.keys(patch) });
    return ok({ resource: { id: updated._id.toHexString(), name: updated.name, active: updated.active } });
  } catch (err) {
    return fail(err, { route: "PATCH /api/admin/resources/[id]" });
  }
}
