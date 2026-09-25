"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowRight, CalendarDays, ChevronRight } from "lucide-react";
import { sportEmoji } from "@/lib/sport";
import { formatMinutes, minutesToDuration } from "@/lib/time";
import { StatusBadge, cn } from "@/components/ui/primitives";

export interface TodayBooking {
  id: string;
  reference: string;
  startMin: number;
  endMin: number;
  customerName: string;
  facilityName: string;
  resourceName: string;
  locationName: string;
  status: string;
}

/**
 * Today's games, filterable by sport.
 *
 * The filter runs here in the browser: the whole day is already on the page and
 * is a few dozen rows at most, so a tap answers at once with no server trip.
 * A sport the chosen ground does not sell is shown but greyed out — hiding it
 * would make the row of buttons jump about between grounds.
 */
export function TodayAtTurf({
  bookings,
  sports,
  nowMin,
  seeAllHref,
}: {
  bookings: TodayBooking[];
  /** Every sport sold anywhere, and whether the ground in view sells it. */
  sports: Array<{ name: string; offered: boolean }>;
  nowMin: number;
  seeAllHref: string;
}) {
  const [sport, setSport] = React.useState("");
  const shown = sport ? bookings.filter((b) => b.facilityName === sport) : bookings;

  return (
    <section className="rounded-2xl border border-ink-200 bg-white p-4 shadow-sm sm:p-6" aria-labelledby="today-heading">
      <div className="flex items-center justify-between gap-3">
        <h2 id="today-heading" className="flex items-center gap-3 text-lg font-bold text-ink-900 sm:text-xl">
          <span className="grid h-11 w-11 place-items-center rounded-xl bg-pitch-50 text-pitch-700">
            <CalendarDays className="h-6 w-6" aria-hidden="true" />
          </span>
          Today at the turf
        </h2>
        <Link
          href={seeAllHref}
          className="inline-flex min-h-[44px] items-center gap-1 rounded-lg px-2 text-sm font-medium text-pitch-700 hover:bg-pitch-50"
        >
          See all
          <ArrowRight className="h-4 w-4" aria-hidden="true" />
        </Link>
      </div>

      {sports.length > 1 ? (
        <div className="relative -mx-4 mt-4 sm:mx-0">
          <div
            role="group"
            aria-label="Sport"
            className="flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] sm:flex-wrap sm:px-0 [&::-webkit-scrollbar]:hidden"
          >
            {[{ name: "", offered: true }, ...sports].map((s) => {
              const on = sport === s.name;
              return (
                <button
                  key={s.name || "all"}
                  type="button"
                  aria-pressed={on}
                  disabled={!s.offered}
                  title={s.offered ? undefined : "Not played at this ground"}
                  onClick={() => setSport(s.name)}
                  className={cn(
                    "flex h-10 shrink-0 items-center gap-1.5 rounded-full border px-4 text-sm font-semibold transition-colors",
                    on
                      ? "border-pitch-600 bg-pitch-600 text-white shadow-sm"
                      : "border-ink-200 bg-white text-ink-700 hover:border-pitch-300",
                    !s.offered && "cursor-not-allowed border-ink-100 bg-ink-50 text-ink-300 opacity-70 hover:border-ink-100",
                  )}
                >
                  {s.name ? (
                    <span aria-hidden="true" className={cn(!s.offered && "grayscale")}>
                      {sportEmoji(s.name)}
                    </span>
                  ) : null}
                  {s.name || "All"}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

      {shown.length === 0 ? (
        <div className="mt-4 flex flex-col items-center rounded-xl bg-ink-50 px-4 py-12 text-center">
          <span className="text-4xl" aria-hidden="true">
            {sport ? sportEmoji(sport) : "🏏"}
          </span>
          <p className="mt-3 text-base font-medium text-ink-700">
            {sport ? `No ${sport} bookings today.` : "No bookings for today yet."}
          </p>
          <p className="text-sm text-ink-500">New ones show up here as they come in.</p>
        </div>
      ) : (
        <ul className="mt-4 space-y-2.5">
          {shown.map((b) => {
            const playing = b.startMin <= nowMin && nowMin < b.endMin;
            const over = b.endMin <= nowMin;
            return (
              <li key={b.id}>
                <Link
                  href={`/admin/bookings?search=${b.reference}`}
                  className={cn(
                    "flex items-center gap-3 rounded-xl border p-3 transition-colors hover:border-pitch-300 hover:bg-pitch-50/50 sm:gap-4 sm:p-4",
                    playing ? "border-pitch-300 bg-pitch-50/60" : "border-ink-100",
                    over && "opacity-60",
                  )}
                >
                  <span
                    className={cn(
                      "w-20 shrink-0 rounded-xl px-1 py-2 text-center sm:w-24",
                      playing ? "bg-pitch-600 text-white" : "bg-ink-100 text-ink-800",
                    )}
                  >
                    <span className="block text-base font-bold tabular-nums">{formatMinutes(b.startMin)}</span>
                    <span className={cn("block text-[11px] font-medium", playing ? "text-pitch-100" : "text-ink-500")}>
                      {playing ? "playing now" : minutesToDuration(b.endMin - b.startMin)}
                    </span>
                  </span>
                  <span
                    aria-hidden="true"
                    className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-orange-50 text-xl"
                  >
                    {sportEmoji(b.facilityName)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-base font-semibold text-ink-900">{b.customerName}</span>
                    {/* Which court, not just which ground: two customers on the two
                        pickleball courts at noon read as one booking twice otherwise. */}
                    <span className="block truncate text-sm text-ink-500">
                      {[b.facilityName, b.resourceName !== b.facilityName ? b.resourceName : null, b.locationName]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </span>
                  <StatusBadge status={b.status} className="hidden shrink-0 sm:inline-flex" />
                  <ChevronRight className="h-5 w-5 shrink-0 text-ink-300" aria-hidden="true" />
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
