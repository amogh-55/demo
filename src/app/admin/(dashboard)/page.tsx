import Link from "next/link";
import type { Metadata } from "next";
import { collections, getDb } from "@/lib/db";
import { formatIstTimestamp, istDateString } from "@/lib/time";
import { StatusBadge, cn } from "@/components/ui/primitives";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Dashboard", robots: { index: false } };

export default async function AdminDashboardPage() {
  const db = await getDb();
  const today = istDateString();

  const [byStatus, todayBookings, pendingPayments, blockedUnits, blockedDays, byLocation, recent] = await Promise.all([
    collections.bookings(db).aggregate<{ _id: string; count: number }>([{ $group: { _id: "$status", count: { $sum: 1 } } }]).toArray(),
    collections.bookings(db).find({ date: today, status: { $in: ["PENDING", "CONFIRMED"] } }).sort({ startMin: 1 }).limit(8).toArray(),
    collections.bookings(db).countDocuments({ status: "PENDING", paymentVerificationStatus: "PENDING" }),
    collections.slotUnits(db).countDocuments({ status: "BLOCKED", date: { $gte: today } }),
    collections.dayBlocks(db).countDocuments({ date: { $gte: today } }),
    collections.bookings(db).aggregate<{ _id: string; count: number }>([
      { $match: { status: { $in: ["PENDING", "CONFIRMED"] }, date: { $gte: today } } },
      { $group: { _id: "$locationName", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]).toArray(),
    collections.auditLogs(db).find({}).sort({ createdAt: -1 }).limit(6).toArray(),
  ]);

  const count = (status: string) => byStatus.find((s) => s._id === status)?.count ?? 0;

  const cards = [
    { label: "Today's bookings", value: todayBookings.length, href: `/admin/bookings?date=${today}`, tone: "neutral" as const },
    { label: "Awaiting verification", value: pendingPayments, href: "/admin/bookings?status=PENDING&payment=PENDING", tone: "warn" as const },
    { label: "Pending", value: count("PENDING"), href: "/admin/bookings?status=PENDING", tone: "warn" as const },
    { label: "Confirmed", value: count("CONFIRMED"), href: "/admin/bookings?status=CONFIRMED", tone: "good" as const },
    { label: "Rejected", value: count("REJECTED"), href: "/admin/bookings?status=REJECTED", tone: "neutral" as const },
    { label: "Blocked ahead", value: blockedUnits + blockedDays, href: "/admin/availability", tone: "neutral" as const },
  ];

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <h1 className="text-xl font-bold text-ink-900">Dashboard</h1>
        <p className="text-sm text-ink-600">{formatIstTimestamp(new Date())} · Asia/Kolkata</p>
      </div>

      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {cards.map((card) => (
          <li key={card.label}>
            <Link
              href={card.href}
              className={cn(
                "block rounded-xl border bg-white p-4 transition-colors hover:border-pitch-400",
                card.tone === "warn" && card.value > 0 ? "border-amber-300 bg-amber-50/60" : "border-ink-200",
              )}
            >
              <p className="text-2xl font-bold text-ink-900">{card.value}</p>
              <p className="mt-0.5 text-xs font-medium text-ink-600">{card.label}</p>
            </Link>
          </li>
        ))}
      </ul>

      <section className="card">
        <h2 className="font-semibold text-ink-900">Today at the turf</h2>
        {todayBookings.length === 0 ? (
          <p className="mt-3 text-sm text-ink-500">No bookings for today.</p>
        ) : (
          <ul className="mt-3 divide-y divide-ink-100">
            {todayBookings.map((b) => (
              <li key={b._id.toHexString()}>
                <Link
                  href={`/admin/bookings?search=${b.reference}`}
                  className="flex flex-wrap items-center justify-between gap-2 py-3 hover:text-pitch-700"
                >
                  <span className="min-w-0 break-words">
                    <span className="font-medium text-ink-900">{b.customerName}</span>
                    <span className="ml-2 text-sm text-ink-500">{b.locationName}</span>
                  </span>
                  <span className="flex shrink-0 items-center gap-3 text-sm">
                    <span className="tabular-nums text-ink-700">
                      {String(Math.floor(b.startMin / 60)).padStart(2, "0")}:{String(b.startMin % 60).padStart(2, "0")}
                    </span>
                    <StatusBadge status={b.status} />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="grid gap-4 sm:grid-cols-2">
        <section className="card">
          <h2 className="font-semibold text-ink-900">Upcoming by location</h2>
          {byLocation.length === 0 ? (
            <p className="mt-3 text-sm text-ink-500">No upcoming bookings.</p>
          ) : (
            <ul className="mt-3 space-y-2 text-sm">
              {byLocation.map((l) => (
                <li key={l._id} className="flex items-center justify-between gap-3">
                  <span className="min-w-0 truncate text-ink-700">{l._id}</span>
                  <span className="shrink-0 font-semibold text-ink-900">{l.count}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="card">
          <h2 className="font-semibold text-ink-900">Recent staff activity</h2>
          {recent.length === 0 ? (
            <p className="mt-3 text-sm text-ink-500">Nothing yet.</p>
          ) : (
            <ul className="mt-3 space-y-2 text-sm">
              {recent.map((a) => (
                <li key={a._id.toHexString()} className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <span className="min-w-0 break-words text-ink-700">
                    <span className="font-medium">{a.adminUsername}</span> · {a.action.replaceAll("_", " ").toLowerCase()}
                  </span>
                  {/* ink-400 on white is under 4.5:1 — too thin for a 12px timestamp on a phone. */}
                  <span className="text-xs text-ink-500">{formatIstTimestamp(a.createdAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
