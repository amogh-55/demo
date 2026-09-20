import { ObjectId } from "mongodb";
import { fail, ok } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { DEFAULT_SLOT_CONFIG } from "@/lib/booking/service";
import { collections, getDb } from "@/lib/db";
import { appError } from "@/lib/errors";

export const dynamic = "force-dynamic";

/** Current schedule and pricing for one location, with defaults filled in. */
export async function GET(request: Request) {
  try {
    await requireAdmin();
    const raw = new URL(request.url).searchParams.get("locationId") ?? "";
    if (!ObjectId.isValid(raw)) throw appError("VALIDATION", "Choose a location first.");

    const db = await getDb();
    const locationId = new ObjectId(raw);
    const stored = await collections.slotConfigs(db).findOne({ locationId });

    return ok({
      config: stored
        ? {
            slotMinutes: stored.slotMinutes,
            openMin: stored.openMin,
            closeMin: stored.closeMin,
            priceRules: stored.priceRules,
            bookingWindowDays: stored.bookingWindowDays,
            holdMinutes: stored.holdMinutes,
          }
        : DEFAULT_SLOT_CONFIG,
      isDefault: !stored,
    });
  } catch (err) {
    return fail(err, { route: "GET /api/admin/config" });
  }
}
