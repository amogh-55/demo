import Link from "next/link";
import type { Metadata } from "next";
import { ObjectId } from "mongodb";
import {
  ArrowRight,
  BadgeCheck,
  Ban,
  CalendarCheck,
  CalendarDays,
  ChevronRight,
  CircleCheck,
  CircleX,
  Clock3,
  Hourglass,
  IndianRupee,
  MapPin,
  type LucideIcon,
} from "lucide-react";
import { getSession } from "@/lib/auth";
import { TO_VERIFY } from "@/lib/booking/admin-list";
import { collections, getDb } from "@/lib/db";
import { sportEmoji } from "@/lib/sport";
import { formatBusinessDate, formatMinutes, istDateString, istMinutesOfDay, minutesToDuration } from "@/lib/time";
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
  const nowMin = istMinutesOfDay();

  const requested = (await searchParams).locationId ?? "";
  const [session, locations] = await Promise.all([
    getSession(),
    collections.locations(db).find({}).sort({ name: 1 }).toArray(),
  ]);
  // An id that is not a real ground falls back to "all", rather than silently
  // showing zeroes as though the turf had no bookings.
  const activeId = locations.some((l) => l._id.toHexString() === requested) ? requested : "";
  const scope = activeId ? { locationId: new ObjectId(activeId) } : {};
  const live = { $in: ["PENDING", "CONFIRMED"] as Array<"PENDING" | "CONFIRMED"> };

  const [byStatus, todayBookings, toVerify, blockedUnits, blockedDays, byLocation, takings] = await Promise.all([
    collections
      .bookings(db)
      .aggregate<{ _id: string; count: number }>([{ $match: scope }, { $group: { _id: "$status", count: { $sum: 1 } } }])
      .toArray(),
    collections
      .bookings(db)
      .find({ ...scope, date: today, status: live })
      .sort({ startMin: 1 })
      .limit(8)
      .toArray(),
    // The same rule as the To verify tab this card opens, so the two numbers
    // can never disagree.
    collections.bookings(db).countDocuments({ ...scope, ...TO_VERIFY }),
    collections.slotUnits(db).countDocuments({ ...scope, status: "BLOCKED", date: { $gte: today } }),
    collections.dayBlocks(db).countDocuments({ ...scope, date: { $gte: today } }),
    collections
      .bookings(db)
      .aggregate<{ _id: string; count: number }>([
        { $match: { ...scope, status: live, date: { $gte: today } } },
        { $group: { _id: "$locationName", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ])
      .toArray(),
    // Money actually collected for today, which is the number an owner opens the
    // page to see — and how many bookings that is across, counted in full rather
    // than read off the eight listed below.
    collections
      .bookings(db)
      .aggregate<{ _id: null; total: number; count: number }>([
        { $match: { ...scope, date: today, status: live } },
        { $group: { _id: null, total: { $sum: { $ifNull: ["$amountPaid", 0] } }, count: { $sum: 1 } } },
      ])
      .toArray(),
  ]);

  const count = (...statuses: string[]) =>
    byStatus.filter((s) => statuses.includes(s._id)).reduce((sum, s) => sum + s.count, 0);
  const collectedToday = takings[0]?.total ?? 0;
  const todayCount = takings[0]?.count ?? 0;
  const pendingCount = count("PENDING");

  /** What is happening now, or next — the question asked walking up to the ground. */
  const next = todayBookings.find((b) => b.endMin > nowMin) ?? null;
  const onNow = next !== null && next.startMin <= nowMin;

  const greeting = nowMin < 12 * 60 ? "Good morning" : nowMin < 17 * 60 ? "Good afternoon" : "Good evening";
  // The whole name: "Turf Owner" cut to its first word greets the owner as "Turf".
  const name = session?.displayName.trim() ?? "";
  const busiest = Math.max(1, ...byLocation.map((l) => l.count));

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <header>
        <p className="flex items-center gap-1.5 text-sm font-medium text-ink-500">
          <CalendarDays className="h-4 w-4" aria-hidden="true" />
          {formatBusinessDate(today)} · {formatMinutes(nowMin)} IST
        </p>
        <h1 className="mt-1 text-2xl font-bold tracking-tight text-ink-900 sm:text-3xl">
          {greeting}
          {name ? `, ${name}` : ""} 👋
        </h1>
      </header>

      {/* Everything below is scoped to the chosen ground, so the filter wraps it:
          while a new ground is loading the figures are dimmed rather than sitting
          there looking like they belong to the ground now named in the dropdown. */}
      <LocationFilter
        locations={locations.map((l) => ({ id: l._id.toHexString(), name: l.name }))}
        value={activeId}
      >
        <div className="space-y-5">
          {/* Today's money and what is on the turf — the glance before the gates open. */}
          <section className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-pitch-600 via-pitch-700 to-pitch-900 p-5 text-white shadow-lg sm:p-7">
            <FieldLines className="pointer-events-none absolute -right-12 -top-8 h-56 w-80 text-white/[0.08]" />
            <p className="relative flex items-center gap-2 text-sm font-medium text-pitch-100">
              <span className="grid h-8 w-8 place-items-center rounded-lg bg-white/15">
                <IndianRupee className="h-4 w-4" aria-hidden="true" />
              </span>
              Collected today
            </p>
            <p className="relative mt-3 text-4xl font-bold tracking-tight tabular-nums sm:text-5xl">
              {formatCurrency(collectedToday)}
            </p>
            <div className="relative mt-5 flex flex-wrap gap-2 text-sm">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-white/15 px-3 py-1.5 font-medium">
                <CalendarCheck className="h-4 w-4" aria-hidden="true" />
                {todayCount} booking{todayCount === 1 ? "" : "s"} today
              </span>
              <span className="inline-flex min-w-0 items-center gap-1.5 rounded-full bg-white/15 px-3 py-1.5 font-medium">
                <Clock3 className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span className="truncate">
                  {next
                    ? `${onNow ? "On now" : "Next"}: ${formatMinutes(next.startMin)} · ${next.customerName}`
                    : "No more games today"}
                </span>
              </span>
            </div>
          </section>

          {/* The two that mean "someone is waiting on you" lead, and say so. */}
          <section aria-labelledby="needs-heading">
            <h2 id="needs-heading" className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-500">
              Needs you
            </h2>
            <div className="grid gap-3 sm:grid-cols-2">
              <ActionCard
                href="/admin/bookings?tab=verify"
                icon={BadgeCheck}
                tone="blue"
                value={toVerify}
                label="Payments to verify"
                hint={toVerify > 0 ? "Screenshots waiting for your check" : "Nothing to check right now"}
              />
              <ActionCard
                href="/admin/bookings?tab=pending"
                icon={Hourglass}
                tone="amber"
                value={pendingCount}
                label="Pending bookings"
                hint={pendingCount > 0 ? "Not yet confirmed" : "Every booking is settled"}
              />
            </div>
          </section>

          <ul className="grid grid-cols-3 gap-3">
            <MiniStat href="/admin/bookings?tab=confirmed" icon={CircleCheck} tone="green" value={count("CONFIRMED")} label="Confirmed" />
            <MiniStat
              href="/admin/bookings?tab=rejected"
              icon={CircleX}
              tone="red"
              value={count("REJECTED", "CANCELLED", "EXPIRED")}
              label="Rejected"
            />
            <MiniStat href="/admin/availability" icon={Ban} tone="ink" value={blockedUnits + blockedDays} label="Blocked ahead" />
          </ul>

          <div className="grid gap-5 lg:grid-cols-3">
            <section className="rounded-2xl border border-ink-200 bg-white p-4 shadow-sm sm:p-5 lg:col-span-2">
              <div className="flex items-center justify-between gap-3">
                <h2 className="flex items-center gap-2.5 font-semibold text-ink-900">
                  <span className="grid h-9 w-9 place-items-center rounded-xl bg-pitch-50 text-pitch-700">
                    <CalendarDays className="h-5 w-5" aria-hidden="true" />
                  </span>
                  Today at the turf
                </h2>
                <Link
                  href={`/admin/bookings?date=${today}`}
                  className="inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-sm font-medium text-pitch-700 hover:bg-pitch-50"
                >
                  See all
                  <ArrowRight className="h-4 w-4" aria-hidden="true" />
                </Link>
              </div>

              {todayBookings.length === 0 ? (
                <div className="mt-4 flex flex-col items-center rounded-xl bg-ink-50 px-4 py-10 text-center">
                  <span className="text-3xl" aria-hidden="true">
                    🏏
                  </span>
                  <p className="mt-2 text-sm font-medium text-ink-700">No bookings for today yet.</p>
                  <p className="text-xs text-ink-500">New ones show up here as they come in.</p>
                </div>
              ) : (
                <ul className="mt-4 space-y-2">
                  {todayBookings.map((b) => {
                    const playing = b.startMin <= nowMin && nowMin < b.endMin;
                    const over = b.endMin <= nowMin;
                    return (
                      <li key={b._id.toHexString()}>
                        <Link
                          href={`/admin/bookings?search=${b.reference}`}
                          className={cn(
                            "flex items-center gap-3 rounded-xl border p-2.5 transition-colors hover:border-pitch-300 hover:bg-pitch-50/50",
                            playing ? "border-pitch-300 bg-pitch-50/60" : "border-ink-100",
                            over && "opacity-60",
                          )}
                        >
                          <span
                            className={cn(
                              "w-[4.5rem] shrink-0 rounded-lg px-1 py-1.5 text-center",
                              playing ? "bg-pitch-600 text-white" : "bg-ink-100 text-ink-800",
                            )}
                          >
                            <span className="block text-sm font-bold tabular-nums">{formatMinutes(b.startMin)}</span>
                            <span className={cn("block text-[10px] font-medium", playing ? "text-pitch-100" : "text-ink-500")}>
                              {playing ? "playing now" : minutesToDuration(b.endMin - b.startMin)}
                            </span>
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-semibold text-ink-900">{b.customerName}</span>
                            {/* Which court, not just which ground. Two customers on the two
                                pickleball courts at noon read as the same booking twice
                                when only the ground is named. */}
                            <span className="block truncate text-xs text-ink-500">
                              <span aria-hidden="true">{sportEmoji(b.facilityName)} </span>
                              {[b.facilityName, b.resourceName !== b.facilityName ? b.resourceName : null, b.locationName]
                                .filter(Boolean)
                                .join(" · ")}
                            </span>
                          </span>
                          <StatusBadge status={b.status} className="hidden shrink-0 sm:inline-flex" />
                          <ChevronRight className="h-4 w-4 shrink-0 text-ink-300" aria-hidden="true" />
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>

            <section className="rounded-2xl border border-ink-200 bg-white p-4 shadow-sm sm:p-5">
              <h2 className="flex items-center gap-2.5 font-semibold text-ink-900">
                <span className="grid h-9 w-9 place-items-center rounded-xl bg-orange-50 text-orange-600">
                  <MapPin className="h-5 w-5" aria-hidden="true" />
                </span>
                Upcoming by ground
              </h2>
              {byLocation.length === 0 ? (
                <p className="mt-4 rounded-xl bg-ink-50 px-4 py-6 text-center text-sm text-ink-500">No upcoming bookings.</p>
              ) : (
                <ul className="mt-4 space-y-4">
                  {byLocation.map((l) => (
                    <li key={l._id}>
                      <div className="flex items-baseline justify-between gap-3 text-sm">
                        <span className="min-w-0 truncate font-medium text-ink-800">{l._id}</span>
                        <span className="shrink-0 font-bold tabular-nums text-ink-900">
                          {l.count}
                          <span className="ml-1 text-xs font-medium text-ink-500">booking{l.count === 1 ? "" : "s"}</span>
                        </span>
                      </div>
                      <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-ink-100">
                        <div
                          className="h-full rounded-full bg-gradient-to-r from-pitch-400 to-pitch-600"
                          style={{ width: `${Math.max(6, (l.count / busiest) * 100)}%` }}
                        />
                      </div>
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

const TONE = {
  blue: { tile: "bg-blue-100 text-blue-700", busy: "border-blue-200 bg-blue-50/60 hover:border-blue-300", value: "text-blue-900" },
  amber: { tile: "bg-amber-100 text-amber-700", busy: "border-amber-200 bg-amber-50/60 hover:border-amber-300", value: "text-amber-900" },
  green: { tile: "bg-green-100 text-green-700", busy: "", value: "text-ink-900" },
  red: { tile: "bg-red-100 text-red-600", busy: "", value: "text-ink-900" },
  ink: { tile: "bg-ink-100 text-ink-600", busy: "", value: "text-ink-900" },
} as const;

/** A to-do with a number on it. Coloured only while there is something to do. */
function ActionCard({
  href,
  icon: Icon,
  tone,
  value,
  label,
  hint,
}: {
  href: string;
  icon: LucideIcon;
  tone: keyof typeof TONE;
  value: number;
  label: string;
  hint: string;
}) {
  const waiting = value > 0;
  return (
    <Link
      href={href}
      className={cn(
        "group flex items-center gap-4 rounded-2xl border p-4 shadow-sm transition-colors",
        waiting ? TONE[tone].busy : "border-ink-200 bg-white hover:border-pitch-300",
      )}
    >
      <span className={cn("grid h-12 w-12 shrink-0 place-items-center rounded-xl", waiting ? TONE[tone].tile : "bg-ink-100 text-ink-500")}>
        <Icon className="h-6 w-6" aria-hidden="true" />
      </span>
      <span className="min-w-0 flex-1">
        <span className={cn("block text-3xl font-bold leading-none tabular-nums", waiting ? TONE[tone].value : "text-ink-900")}>
          {value}
        </span>
        <span className="mt-1 block text-sm font-semibold text-ink-800">{label}</span>
        <span className="block truncate text-xs text-ink-500">{hint}</span>
      </span>
      <ChevronRight className="h-5 w-5 shrink-0 text-ink-300 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
    </Link>
  );
}

function MiniStat({
  href,
  icon: Icon,
  tone,
  value,
  label,
}: {
  href: string;
  icon: LucideIcon;
  tone: keyof typeof TONE;
  value: number;
  label: string;
}) {
  return (
    <li>
      <Link
        href={href}
        className="flex h-full flex-col items-center gap-1.5 rounded-2xl border border-ink-200 bg-white p-3 text-center shadow-sm transition-colors hover:border-pitch-300 sm:flex-row sm:gap-3 sm:p-4 sm:text-left"
      >
        <span className={cn("grid h-9 w-9 shrink-0 place-items-center rounded-xl", TONE[tone].tile)}>
          <Icon className="h-5 w-5" aria-hidden="true" />
        </span>
        <span className="min-w-0">
          <span className="block text-xl font-bold leading-tight tabular-nums text-ink-900 sm:text-2xl">{value}</span>
          <span className="block text-[11px] font-medium text-ink-600 sm:text-xs">{label}</span>
        </span>
      </Link>
    </li>
  );
}

/** Faint pitch markings behind the takings, so the hero reads as a turf and not a bank app. */
function FieldLines({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 320 200" fill="none" stroke="currentColor" strokeWidth="3" className={className} aria-hidden="true">
      <rect x="10" y="10" width="300" height="180" rx="10" />
      <path d="M160 10v180M10 60h50v80H10M310 60h-50v80h50" />
      <circle cx="160" cy="100" r="34" />
    </svg>
  );
}
