import Link from "next/link";
import type { Metadata } from "next";
import { ObjectId } from "mongodb";
import { collections, getDb } from "@/lib/db";
import { formatCompactRange, formatIstTimestamp, istDateString } from "@/lib/time";
import { StatusBadge, cn, formatCurrency } from "@/components/ui/primitives";
import { LocationFilter } from "@/components/admin/location-filter";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Dashboard", robots: { index: false } };

export default async function AdminDashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ locationId?: string }>;
}) {
  const db = await getDb();
  const today = istDateString();

  const requested = (await searchParams).locationId ?? "";
  const locations = await collections.locations(db).find({}).sort({ name: 1 }).toArray();
  // An id that is not a real ground falls back to "all", rather than silently
  // showing zeroes as though the turf had no bookings.
  const activeId = locations.some((l) => l._id.toHexString() === requested) ? requested : "";
  const scope = activeId ? { locationId: new ObjectId(activeId) } : {};

  const [byStatus, todayBookings, pendingPayments, blockedUnits, blockedDays, byLocation, recent, takings] =
    await Promise.all([
      collections
        .bookings(db)
        .aggregate<{ _id: string; count: number }>([
          { $match: scope },
          { $group: { _id: "$status", count: { $sum: 1 } } },
        ])
        .toArray(),
      collections
        .bookings(db)
        .find({ ...scope, date: today, status: { $in: ["PENDING", "CONFIRMED"] } })
        .sort({ startMin: 1 })
        .limit(8)
        .toArray(),
      collections.bookings(db).countDocuments({ ...scope, status: "PENDING", paymentVerificationStatus: "PENDING" }),
      collections.slotUnits(db).countDocuments({ ...scope, status: "BLOCKED", date: { $gte: today } }),
      collections.dayBlocks(db).countDocuments({ ...scope, date: { $gte: today } }),
      collections
        .bookings(db)
        .aggregate<{ _id: string; count: number }>([
          { $match: { ...scope, status: { $in: ["PENDING", "CONFIRMED"] }, date: { $gte: today } } },
          { $group: { _id: "$locationName", count: { $sum: 1 } } },
          { $sort: { count: -1 } },
        ])
        .toArray(),
      collections
        .auditLogs(db)
        .find({})
        .sort({ createdAt: -1 })
        .limit(6)
        .toArray(),
      // Money actually collected for today, which is the number an owner opens
      // the page to see.
      collections
        .bookings(db)
        .aggregate<{ _id: null; total: number }>([
          { $match: { ...scope, date: today, status: { $in: ["PENDING", "CONFIRMED"] } } },
          { $group: { _id: null, total: { $sum: { $ifNull: ["$amountPaid", 0] } } } },
        ])
        .toArray(),
    ]);

  const count = (status: string) => byStatus.find((s) => s._id === status)?.count ?? 0;
  const collectedToday = takings[0]?.total ?? 0;

  /** The two that mean "someone is waiting on you" lead, and say so. */
  const needsAction = [
    {
      label: "Awaiting verification",
      value: pendingPayments,
      href: "/admin/bookings?status=PENDING&payment=PENDING",
      hint: "Screenshots to check",
    },
    { label: "Pending bookings", value: count("PENDING"), href: "/admin/bookings?status=PENDING", hint: "Not yet accepted" },
  ];

  const summary = [
    { label: "Confirmed", value: count("CONFIRMED"), href: "/admin/bookings?status=CONFIRMED" },
    { label: "Rejected", value: count("REJECTED"), href: "/admin/bookings?status=REJECTED" },
    { label: "Blocked ahead", value: blockedUnits + blockedDays, href: "/admin/availability" },
  ];

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-ink-900">Dashboard</h1>
          {/* The ground is not named here on purpose: the dropdown below is the
              single place that says which one is shown, so the two can never
              contradict each other while a switch is in flight. */}
          <p className="mt-0.5 text-sm text-ink-600">{formatIstTimestamp(new Date())} · Asia/Kolkata</p>
        </div>
      </header>

      {/* Everything below is scoped to the chosen ground, so the filter wraps it:
          while a new ground is loading the figures are dimmed rather than sitting
          there looking like they belong to the ground now named in the dropdown. */}
      <LocationFilter
        locations={locations.map((l) => ({ id: l._id.toHexString(), name: l.name }))}
        value={activeId}
      >
      <div className="space-y-5">
      {/* Today's money and today's count, side by side — the two things worth a
          glance before the turf opens. */}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-xl border border-pitch-200 bg-pitch-50 p-4 sm:p-5">
          <p className="text-xs font-semibold uppercase tracking-wide text-pitch-700">Collected today</p>
          <p className="mt-1 text-3xl font-bold tracking-tight text-pitch-900">{formatCurrency(collectedToday)}</p>
          <p className="mt-0.5 text-xs text-pitch-700">across {todayBookings.length} booking{todayBookings.length === 1 ? "" : "s"}</p>
        </div>

        <ul className="grid grid-cols-2 gap-3">
          {needsAction.map((card) => (
            <li key={card.label}>
              <Link
                href={card.href}
                className={cn(
                  "flex h-full flex-col justify-between rounded-xl border p-4 transition-colors",
                  card.value > 0
                    ? "border-amber-300 bg-amber-50 hover:border-amber-400"
                    : "border-ink-200 bg-white hover:border-pitch-400",
                )}
              >
                <p className={cn("text-3xl font-bold tracking-tight", card.value > 0 ? "text-amber-900" : "text-ink-900")}>
                  {card.value}
                </p>
                <div className="mt-1">
                  <p className="text-xs font-semibold text-ink-800">{card.label}</p>
                  <p className="text-[11px] text-ink-500">{card.hint}</p>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      </div>

      <ul className="grid grid-cols-3 gap-3">
        {summary.map((card) => (
          <li key={card.label}>
            <Link
              href={card.href}
              className="block rounded-xl border border-ink-200 bg-white p-3 text-center transition-colors hover:border-pitch-400 sm:p-4"
            >
              <p className="text-xl font-bold text-ink-900 sm:text-2xl">{card.value}</p>
              <p className="mt-0.5 text-[11px] font-medium text-ink-600 sm:text-xs">{card.label}</p>
            </Link>
          </li>
        ))}
      </ul>

      <section className="card">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="font-semibold text-ink-900">Today at the turf</h2>
          <Link href={`/admin/bookings?date=${today}`} className="text-xs font-medium text-pitch-700 hover:underline">
            See all
          </Link>
        </div>
        {todayBookings.length === 0 ? (
          <p className="mt-3 text-sm text-ink-500">No bookings for today.</p>
        ) : (
          <ul className="mt-2 divide-y divide-ink-100">
            {todayBookings.map((b) => (
              <li key={b._id.toHexString()}>
                <Link
                  href={`/admin/bookings?search=${b.reference}`}
                  className="flex flex-col gap-1 py-3 transition-colors hover:text-pitch-700 sm:flex-row sm:items-center sm:justify-between sm:gap-3"
                >
                  <span className="min-w-0">
                    <span className="block break-words font-medium text-ink-900">{b.customerName}</span>
                    {/* Which court, not just which ground. Two customers on the two
                        pickleball courts at noon read as the same booking twice
                        when only the ground is named. */}
                    <span className="block break-words text-xs text-ink-500">
                      {[b.locationName, b.facilityName, b.resourceName !== b.facilityName ? b.resourceName : null]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-3 text-sm">
                    {/* The whole slot, not just its start — same reason as the customer grid. */}
                    <span className="tabular-nums font-medium text-ink-700">
                      {formatCompactRange(b.startMin, b.endMin)}
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
          <h2 className="font-semibold text-ink-900">Upcoming by ground</h2>
          {byLocation.length === 0 ? (
            <p className="mt-3 text-sm text-ink-500">No upcoming bookings.</p>
          ) : (
            <ul className="mt-3 space-y-2.5 text-sm">
              {byLocation.map((l) => (
                <li key={l._id} className="flex items-center justify-between gap-3">
                  <span className="min-w-0 truncate text-ink-700">{l._id}</span>
                  <span className="shrink-0 rounded-full bg-ink-100 px-2 py-0.5 text-xs font-semibold text-ink-800">
                    {l.count}
                  </span>
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
      </LocationFilter>
    </div>
  );
}
