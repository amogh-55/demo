import type { ObjectId } from "mongodb";
import { fail, ok, readJson } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import {
  blockDay,
  blockSlots,
  findBlockConflicts,
  resolveBlockTargets,
  unblockDay,
  unblockSlots,
  type BlockConflict,
} from "@/lib/booking/service";
import { appError } from "@/lib/errors";
import { blockDaySchema, blockSlotsSchema, unblockDaySchema, unblockSlotsSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

/** What the admin chose to close: one court, a whole facility, or the ground. */
type Target = { resourceId?: ObjectId; facilityId?: ObjectId; locationId?: ObjectId };

function auditTarget(target: Target): { entityType: string; entityId: string } {
  if (target.resourceId) return { entityType: "resource", entityId: target.resourceId.toHexString() };
  if (target.facilityId) return { entityType: "facility", entityId: target.facilityId.toHexString() };
  return { entityType: "location", entityId: target.locationId!.toHexString() };
}

/**
 * Block slots or a whole day, across one resource or every resource under a
 * facility or a ground.
 *
 * Confirmed bookings are never blocked over — the service refuses outright.
 * Live holds and pending requests come back as `conflicts` with `blocked: 0`
 * so the admin sees exactly whose booking they are about to disrupt, and only a
 * second call carrying `force: true` goes through.
 *
 * A block covering several resources is scanned across ALL of them before any of
 * them is written. Without that pre-pass, closing a ground whose first court is
 * free and whose second has a pending booking would shut the first and then stop
 * to ask — leaving half a ground closed on the strength of a question the admin
 * has not answered yet.
 */
export async function POST(request: Request) {
  try {
    const admin = await requireAdmin();
    const body = (await readJson(request)) as Record<string, unknown>;
    const scope = body.scope === "DAY" ? "DAY" : "SLOTS";

    const input = scope === "DAY" ? blockDaySchema.parse(body) : blockSlotsSchema.parse(body);
    const slots = scope === "SLOTS" ? (input as ReturnType<typeof blockSlotsSchema.parse>) : null;
    if (slots && slots.endMin <= slots.startMin) {
      throw appError("VALIDATION", "The end time must be after the start time.");
    }

    const resourceIds = await resolveBlockTargets(input);
    // A day block covers the whole clock, whatever the facility's hours are.
    const from = slots ? slots.startMin : 0;
    const to = slots ? slots.endMin : 1440;

    const conflicts: BlockConflict[] = [];
    for (const resourceId of resourceIds) {
      conflicts.push(...(await findBlockConflicts(resourceId, input.date, from, to)));
    }

    const confirmed = conflicts.filter((c) => c.status === "BOOKED");
    if (confirmed.length > 0) {
      throw appError(
        "CONFLICT",
        scope === "DAY"
          ? "This day contains confirmed bookings. Cancel or move those bookings before blocking the day."
          : "This period contains confirmed bookings. Cancel or move those bookings before blocking it.",
        { conflicts },
      );
    }
    if (conflicts.length > 0 && !input.force) {
      return ok({ scope, blocked: 0, conflicts, needsConfirmation: true });
    }

    let blocked = 0;
    for (const resourceId of resourceIds) {
      const outcome = slots
        ? await blockSlots({ ...slots, resourceId, admin })
        : await blockDay({ ...(input as ReturnType<typeof blockDaySchema.parse>), resourceId, admin });
      blocked += outcome.blocked;
    }

    if (blocked > 0) {
      const { entityType, entityId } = auditTarget(input);
    }

    return ok({ scope, blocked, conflicts: input.force ? conflicts : [], needsConfirmation: false });
  } catch (err) {
    return fail(err, { route: "POST /api/admin/blocks" });
  }
}

export async function DELETE(request: Request) {
  try {
    const admin = await requireAdmin();
    const body = (await readJson(request)) as Record<string, unknown>;
    const scope = body.scope === "DAY" ? "DAY" : "SLOTS";

    const input = scope === "DAY" ? unblockDaySchema.parse(body) : unblockSlotsSchema.parse(body);
    const resourceIds = await resolveBlockTargets(input);
    const { entityType, entityId } = auditTarget(input);

    let unblocked = 0;
    for (const resourceId of resourceIds) {
      if (scope === "DAY") {
        unblocked += (await unblockDay(resourceId, input.date)) ? 1 : 0;
      } else {
        const slots = input as ReturnType<typeof unblockSlotsSchema.parse>;
        unblocked += await unblockSlots({ ...slots, resourceId });
      }
    }

    return ok({ scope, unblocked });
  } catch (err) {
    return fail(err, { route: "DELETE /api/admin/blocks" });
  }
}
