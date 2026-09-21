import { ObjectId } from "mongodb";
import { fail, ok } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { loadResourceContext } from "@/lib/booking/service";
import { collections, getDb } from "@/lib/db";
import { appError } from "@/lib/errors";
import { isValidBusinessDate } from "@/lib/time";
import type { PublicSlotStatus } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * The admin view of one resource-day. Unlike the public availability endpoint it
 * includes who holds each slot, because the owner needs that to decide whether a
 * block is safe. It is behind the admin session for exactly that reason.
 */
export async function GET(request: Request) {
  try {
    await requireAdmin();
    const url = new URL(request.url);
    const rawId = url.searchParams.get("resourceId") ?? "";
    const date = url.searchParams.get("date") ?? "";
    if (!ObjectId.isValid(rawId)) throw appError("VALIDATION", "Choose a court or pitch first.");
    if (!isValidBusinessDate(date)) throw appError("VALIDATION", "Choose a valid date.");

    const resourceId = new ObjectId(rawId);
    const db = await getDb();
    // Inactive resources still need managing, so activity is not required here.
    const context = await loadResourceContext(db, resourceId, false);
    const { location, facility, resource, config } = context;
    // Priced for the day being looked at: a Saturday costs what Saturdays cost.
    const template = context.templateFor(date);

    const now = new Date();
    const [stored, dayBlock] = await Promise.all([
      collections.slotUnits(db).find({ resourceId, date }).toArray(),
      collections.dayBlocks(db).findOne({ resourceId, date }),
    ]);

    const bookingIds = stored.map((u) => u.bookingId).filter((id): id is ObjectId => Boolean(id));
    const bookings = bookingIds.length
      ? await collections.bookings(db).find({ _id: { $in: bookingIds } }).toArray()
      : [];
    const byBookingId = new Map(bookings.map((b) => [b._id.toHexString(), b]));
    const byStart = new Map(stored.map((u) => [u.startMin, u]));

    const units = template.map((slot) => {
      const unit = byStart.get(slot.startMin);
      let status: PublicSlotStatus = "AVAILABLE";
      if (unit) {
        status =
          unit.status === "HELD"
            ? unit.holdUntil && unit.holdUntil.getTime() > now.getTime()
              ? "HELD"
              : "AVAILABLE"
            : unit.status;
      }
      const booking = unit?.bookingId ? byBookingId.get(unit.bookingId.toHexString()) : undefined;

      return {
        startMin: slot.startMin,
        endMin: slot.endMin,
        price: slot.price,
        status,
        blockReason: unit?.blockReason ?? null,
        holdUntil: status === "HELD" ? unit?.holdUntil?.toISOString() ?? null : null,
        booking: booking
          ? {
              id: booking._id.toHexString(),
              reference: booking.reference,
              customerName: booking.customerName,
              status: booking.status,
            }
          : null,
      };
    });

    return ok({
      location: { id: location._id.toHexString(), name: location.name, active: location.active },
      facility: {
        id: facility._id.toHexString(),
        name: facility.name,
        kind: facility.kind,
        active: facility.active,
      },
      resource: { id: resource._id.toHexString(), name: resource.name, active: resource.active },
      date,
      config: {
        openMin: config.openMin,
        closeMin: config.closeMin,
        slotMinutes: config.slotMinutes,
        /**
         * An OVERS facility prices every unit at 0 — the ball carries the money —
         * so the grid has to be told what a block actually costs, or it shows the
         * owner a wall of "₹0" for a machine they charge ₹100 to use.
         */
        oversPerSlot: config.oversPerSlot,
        ballTypes: config.ballTypes,
      },
      dayBlock: dayBlock ? { reason: dayBlock.reason, blockedBy: dayBlock.blockedBy } : null,
      units,
    });
  } catch (err) {
    return fail(err, { route: "GET /api/admin/day" });
  }
}
