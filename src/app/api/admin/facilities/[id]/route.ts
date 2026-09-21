import { ObjectId } from "mongodb";
import { fail, ok, readJson } from "@/lib/api";
import { recordAudit, requireAdmin } from "@/lib/auth";
import { forgetResourceContext } from "@/lib/booking/service";
import { collections, getDb } from "@/lib/db";
import { appError } from "@/lib/errors";
import { facilityConfigSchema, facilityUpdateSchema } from "@/lib/validation";
import type { FacilityConfig } from "@/lib/types";

export const dynamic = "force-dynamic";

function parseId(raw: string): ObjectId {
  if (!ObjectId.isValid(raw)) throw appError("NOT_FOUND", "That facility does not exist.");
  return new ObjectId(raw);
}

/**
 * Rename a facility or hide it. Deactivating stops NEW bookings only — existing
 * bookings and their history are never touched, let alone deleted.
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const admin = await requireAdmin();
    const id = parseId((await params).id);
    const patch = facilityUpdateSchema.parse(await readJson(request));
    if (Object.keys(patch).length === 0) throw appError("VALIDATION", "Nothing to update.");

    const db = await getDb();
    const updated = await collections
      .facilities(db)
      .findOneAndUpdate({ _id: id }, { $set: { ...patch, updatedAt: new Date() } }, { returnDocument: "after" });
    if (!updated) throw appError("NOT_FOUND", "That facility does not exist.");

    await recordAudit(admin, "FACILITY_UPDATED", "facility", id.toHexString(), { fields: Object.keys(patch) });
    // The cached resource context still describes this as it was, so it is
    // dropped now the write has landed — the owner sees their own edit at
    // once rather than whenever the short TTL happens to lapse.
    forgetResourceContext();
    return ok({ facility: { id: updated._id.toHexString(), name: updated.name, active: updated.active } });
  } catch (err) {
    return fail(err, { route: "PATCH /api/admin/facilities/[id]" });
  }
}

/** Operating hours, prices, booking window, overs ladder and ball types. */
export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const admin = await requireAdmin();
    const id = parseId((await params).id);
    const submitted = facilityConfigSchema.parse(await readJson(request));

    const db = await getDb();
    const facility = await collections.facilities(db).findOne({ _id: id });
    if (!facility) throw appError("NOT_FOUND", "That facility does not exist.");

    // Slot length is the unit the double-booking index is built on. Changing it
    // under live rows would split or merge the very documents that guarantee one
    // booking per slot, so it is only allowed while nothing is reserved.
    if (submitted.slotMinutes !== facility.config.slotMinutes) {
      const live = await collections
        .slotUnits(db)
        .countDocuments({ facilityId: id, status: { $in: ["HELD", "PENDING", "BOOKED"] } });
      if (live > 0) {
        throw appError(
          "CONFLICT",
          "Slot length cannot change while this facility has bookings. Clear or complete them first.",
        );
      }
    }

    // The two kinds keep different halves of the config, and the half that does
    // not apply is cleared rather than stored: a stale overs ladder on an hourly
    // pitch would eventually be read by someone as a rule that is in force.
    let config: FacilityConfig;
    if (facility.kind === "OVERS") {
      if (submitted.ballTypes.length === 0) throw appError("VALIDATION", "Add at least one ball type and its price.");
      if (submitted.oversPerSlot <= 0) throw appError("VALIDATION", "Say how many overs one slot covers.");
      config = {
        ...submitted,
        // The price of an overs session comes from its ball, so the bands exist
        // only to mark the hours as sellable. Written here so an admin can never
        // leave a gap that silently makes part of the day unbookable.
        priceRules: [{ fromMin: submitted.openMin, toMin: submitted.closeMin, price: 0 }],
      };
    } else {
      config = { ...submitted, oversPerSlot: 0, payAtVenueMaxOvers: 0, ballTypes: [] };
    }

    await collections.facilities(db).updateOne({ _id: id }, { $set: { config, updatedAt: new Date() } });

    // Existing bookings keep their price snapshot; only future pricing changes.
    await recordAudit(admin, "PRICE_CHANGED", "facility", id.toHexString(), {
      openMin: config.openMin,
      closeMin: config.closeMin,
      slotMinutes: config.slotMinutes,
      priceRules: config.priceRules,
      ballTypes: config.ballTypes,
      oversPerSlot: config.oversPerSlot,
      payAtVenueMaxOvers: config.payAtVenueMaxOvers,
    });

    // The cached resource context still describes this as it was, so it is
    // dropped now the write has landed — the owner sees their own edit at
    // once rather than whenever the short TTL happens to lapse.
    forgetResourceContext();
    return ok({ saved: true, config });
  } catch (err) {
    return fail(err, { route: "PUT /api/admin/facilities/[id]" });
  }
}
