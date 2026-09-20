import { fail, ok, readJson } from "@/lib/api";
import { recordAudit, requireAdmin } from "@/lib/auth";
import { blockDay, blockSlots, unblockDay, unblockSlots } from "@/lib/booking/service";
import { appError } from "@/lib/errors";
import { blockDaySchema, blockSlotsSchema, unblockDaySchema, unblockSlotsSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

/**
 * Block slots or a whole day.
 *
 * Confirmed bookings are never blocked over — the service refuses outright.
 * Live holds and pending requests come back as `conflicts` with `blocked: 0`
 * so the admin sees exactly whose booking they are about to disrupt, and only a
 * second call carrying `force: true` goes through.
 */
export async function POST(request: Request) {
  try {
    const admin = await requireAdmin();
    const body = (await readJson(request)) as Record<string, unknown>;
    const scope = body.scope === "DAY" ? "DAY" : "SLOTS";

    if (scope === "DAY") {
      const input = blockDaySchema.parse(body);
      const outcome = await blockDay({ ...input, admin });
      if (outcome.blocked > 0) {
        await recordAudit(admin, "DAY_BLOCKED", "location", input.locationId.toHexString(), {
          date: input.date,
          reason: input.reason,
          forced: input.force,
        });
      }
      return ok({ scope, ...outcome, needsConfirmation: outcome.blocked === 0 && outcome.conflicts.length > 0 });
    }

    const input = blockSlotsSchema.parse(body);
    if (input.endMin <= input.startMin) throw appError("VALIDATION", "The end time must be after the start time.");

    const outcome = await blockSlots({ ...input, admin });
    if (outcome.blocked > 0) {
      await recordAudit(admin, "SLOT_BLOCKED", "location", input.locationId.toHexString(), {
        date: input.date,
        startMin: input.startMin,
        endMin: input.endMin,
        reason: input.reason,
        forced: input.force,
      });
    }
    return ok({ scope, ...outcome, needsConfirmation: outcome.blocked === 0 && outcome.conflicts.length > 0 });
  } catch (err) {
    return fail(err, { route: "POST /api/admin/blocks" });
  }
}

export async function DELETE(request: Request) {
  try {
    const admin = await requireAdmin();
    const body = (await readJson(request)) as Record<string, unknown>;

    if (body.scope === "DAY") {
      const input = unblockDaySchema.parse(body);
      const removed = await unblockDay(input.locationId, input.date);
      await recordAudit(admin, "DAY_UNBLOCKED", "location", input.locationId.toHexString(), { date: input.date });
      return ok({ scope: "DAY", unblocked: removed ? 1 : 0 });
    }

    const input = unblockSlotsSchema.parse(body);
    const unblocked = await unblockSlots(input);
    await recordAudit(admin, "SLOT_UNBLOCKED", "location", input.locationId.toHexString(), {
      date: input.date,
      startMin: input.startMin,
      endMin: input.endMin,
      unblocked,
    });
    return ok({ scope: "SLOTS", unblocked });
  } catch (err) {
    return fail(err, { route: "DELETE /api/admin/blocks" });
  }
}
