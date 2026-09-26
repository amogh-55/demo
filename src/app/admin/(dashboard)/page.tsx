import Link from "next/link";
import type { Metadata } from "next";
import { ObjectId } from "mongodb";
import {
  BadgeCheck,
  Ban,
  CalendarCheck,
  ChevronRight,
  CircleCheck,
  CircleX,
  Clock3,
  Hourglass,
  IndianRupee,
  type LucideIcon,
} from "lucide-react";
import { TO_VERIFY, upcomingFilter } from "@/lib/booking/admin-list";
import { collections, getDb } from "@/lib/db";
import { formatCompactRange, istDateString, istMinutesOfDay } from "@/lib/time";
import { cn, formatCurrency } from "@/components/ui/primitives";
import { LocationFilter } from "@/components/admin/location-filter";
import { TodayAtTurf } from "@/components/admin/today-at-turf";

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
  const [locations, facilities] = await Promise.all([
    collections.locations(db).find({}).sort({ name: 1 }).toArray(),
    collections
      .facilities(db)
      .find({ active: true }, { projection: { name: 1, locationId: 1, sortOrder: 1 } })
      .sort({ sortOrder: 1, name: 1 })
      .toArray(),
  ]);
  // One ground or several, comma-separated. An id that is not a real ground is
  // dropped, rather than silently showing zeroes as though the turf had no bookings.
  const wanted = requested.split(",");
  const activeIds = locations.map((l) => l._id.toHexString()).filter((id) => wanted.includes(id));
  const activeId = activeIds.join(",");
  const scope = activeIds.length ? { locationId: { $in: activeIds.map((id) => new ObjectId(id)) } } : {};
  const live = { $in: ["PENDING", "CONFIRMED"] as Array<"PENDING" | "CONFIRMED"> };

  const [byStatus, todayBookings, toVerify, upcoming, blockedUnits, blockedDays, takings] = await Promise.all([
    collections
      .bookings(db)
      .aggregate<{ _id: string; count: number }>([{ $match: scope }, { $group: { _id: "$status", count: { $sum: 1 } } }])
      .toArray(),
    // The whole day, not a sample: this list is what the owner runs the gate from.
    collections
      .bookings(db)
      .find({ ...scope, date: today, status: live })
      .sort({ startMin: 1 })
      .limit(200)
      .toArray(),
    // The same rule as the To verify tab this card opens, so the two numbers
    // can never disagree.
    collections.bookings(db).countDocuments({ ...scope, ...TO_VERIFY }),
    // Still to be played, the same as the Confirmed filter this card opens:
    // once a game's end time passes it moves to Completed.
    collections.bookings(db).countDocuments({ ...scope, ...upcomingFilter() }),
    collections.slotUnits(db).countDocuments({ ...scope, status: "BLOCKED", date: { $gte: today } }),
    collections.dayBlocks(db).countDocuments({ ...scope, date: { $gte: today } }),
    // Money actually collected for today, which is the number an owner opens the
    // page to see — and how many bookings that is across.
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

  /**
   * Every sport sold anywhere, once each, and whether the grounds in view sell
   * it. "Bowling Machine" is one button however many grounds have one.
   */
  const sports = [...new Set(facilities.map((f) => f.name))].map((name) => ({
    name,
    offered: facilities.some((f) => f.name === name && (!activeId || activeIds.includes(f.locationId.toHexString()))),
  }));

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      {/* The tabs and the card already say where the owner is; a greeting and a
          clock above them only pushed today's games further down the phone. */}
      <h1 className="sr-only">Dashboard</h1>

      {/* Everything below is scoped to the chosen ground, so the filter wraps it:
          while a new ground is loading the figures are dimmed rather than sitting
          there looking like they belong to the ground now highlighted. */}
      <LocationFilter
        locations={locations.map((l) => ({ id: l._id.toHexString(), name: l.name }))}
        value={activeId}
      >
        <div className="space-y-4">
          {/* Today's money and what is on the turf — the glance before the gates open. */}
          <section className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-pitch-600 via-pitch-700 to-pitch-900 p-4 text-white shadow-md sm:p-5">
            <FieldLines className="pointer-events-none absolute -right-10 -top-6 h-40 w-60 text-white/[0.08]" />
            <p className="relative flex items-center gap-2 text-sm font-medium text-pitch-100">
              <IndianRupee className="h-4 w-4" aria-hidden="true" />
              Collected today
            </p>
            <p className="relative mt-1 text-3xl font-bold tracking-tight tabular-nums sm:text-4xl">
              {formatCurrency(collectedToday)}
            </p>
            <div className="relative mt-3 flex flex-wrap gap-1.5 text-xs sm:text-sm">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-white/15 px-2.5 py-1 font-medium">
                <CalendarCheck className="h-3.5 w-3.5" aria-hidden="true" />
                {todayCount} booking{todayCount === 1 ? "" : "s"} today
              </span>
              <span className="inline-flex min-w-0 items-center gap-1.5 rounded-full bg-white/15 px-2.5 py-1 font-medium">
                <Clock3 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span className="truncate">
                  {next
                    ? `${onNow ? "On now" : "Next"}: ${formatCompactRange(next.startMin, next.endMin)} · ${next.customerName}`
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
            <MiniStat href="/admin/bookings?tab=confirmed" icon={CircleCheck} tone="green" value={upcoming} label="Confirmed" />
            <MiniStat
              href="/admin/bookings?tab=rejected"
              icon={CircleX}
              tone="red"
              value={count("REJECTED", "CANCELLED", "EXPIRED")}
              label="Rejected"
            />
            <MiniStat href="/admin/availability" icon={Ban} tone="ink" value={blockedUnits + blockedDays} label="Blocked ahead" />
          </ul>

          {/* Keyed by ground so a sport picked at one ground is not left
              selected — and greyed out — at the next. */}
          <TodayAtTurf
            key={activeId || "all"}
            nowMin={nowMin}
            sports={sports}
            seeAllHref={`/admin/bookings?date=${today}${activeId ? `&locationId=${activeId}` : ""}`}
            bookings={todayBookings.map((b) => ({
              id: b._id.toHexString(),
              reference: b.reference,
              startMin: b.startMin,
              endMin: b.endMin,
              customerName: b.customerName,
              facilityName: b.facilityName ?? "",
              resourceName: b.resourceName ?? "",
              locationName: b.locationName,
              status: b.status,
            }))}
          />
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
