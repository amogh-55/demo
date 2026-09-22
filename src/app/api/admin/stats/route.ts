import { fail, ok } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { collections, getDb } from "@/lib/db";
import { istDateString } from "@/lib/time";

export const dynamic = "force-dynamic";

/** Dashboard counters. One aggregation per grouping rather than a query per card. */
export async function GET() {
  try {
    await requireAdmin();
    const db = await getDb();
    const today = istDateString();
    const now = new Date();

    const [byStatus, byLocation, todayBookings, blockedUnits, blockedDays, pendingPayments] = await Promise.all([
      collections.bookings(db).aggregate<{ _id: string; count: number }>([
        { $group: { _id: "$status", count: { $sum: 1 } } },
      ]).toArray(),
      collections.bookings(db).aggregate<{ _id: string; name: string; count: number }>([
        { $match: { status: { $in: ["PENDING", "CONFIRMED"] } } },
        { $group: { _id: "$locationName", count: { $sum: 1 } } },
        { $project: { name: "$_id", count: 1 } },
        { $sort: { count: -1 } },
      ]).toArray(),
      collections.bookings(db).countDocuments({ date: today, status: { $in: ["PENDING", "CONFIRMED"] } }),
      collections.slotUnits(db).countDocuments({ status: "BLOCKED", date: { $gte: today } }),
      collections.dayBlocks(db).countDocuments({ date: { $gte: today } }),
      collections.bookings(db).countDocuments({ status: "PENDING", paymentVerificationStatus: "PENDING" }),
    ]);

    const statusCount = (status: string) => byStatus.find((s) => s._id === status)?.count ?? 0;

    return ok({
      today,
      generatedAt: now.toISOString(),
      todayBookings,
      pending: statusCount("PENDING"),
      confirmed: statusCount("CONFIRMED"),
      rejected: statusCount("REJECTED"),
      pendingPayments,
      blockedUnits,
      blockedDays,
      byLocation: byLocation.map((l) => ({ name: l.name, count: l.count })),
    });
  } catch (err) {
    return fail(err, { route: "GET /api/admin/stats" });
  }
}
