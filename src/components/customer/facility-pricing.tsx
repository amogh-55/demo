import { formatCompactRange } from "@/lib/time";
import { formatCurrency } from "@/components/ui/primitives";
import type { PublicLocationTree } from "@/lib/catalog";

type Facility = PublicLocationTree["facilities"][number];
type Band = Facility["priceBands"][number];

/** 0 Sunday … 6 Saturday, in the order a week is spoken. */
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

/**
 * Which days a table covers, written the way a board at the gate would: a run of
 * days becomes "Fri–Sun", anything else is listed.
 */
function describeDays(days: number[]): string {
  const ordered = WEEK_ORDER.filter((d) => days.includes(d));
  if (ordered.length === 0) return "";
  if (ordered.length === 7) return "Every day";

  const positions = ordered.map((d) => WEEK_ORDER.indexOf(d));
  const consecutive = positions.every((p, i) => i === 0 || p === positions[i - 1]! + 1);
  if (consecutive && ordered.length > 2) {
    return `${DAY_NAMES[ordered[0]!]}–${DAY_NAMES[ordered[ordered.length - 1]!]}`;
  }
  return ordered.map((d) => DAY_NAMES[d]).join(", ");
}

/**
 * The owner's bands as a customer reads them. A day runs 12 AM to 12 AM, so a
 * night price is stored as 12–6 AM plus 6 PM–12 AM; at one price those are shown
 * as the one night they are, "6 PM – 6 AM". Display only — pricing is untouched.
 */
function readable(bands: Band[]): Band[] {
  const sorted = [...bands].sort((a, b) => a.fromMin - b.fromMin);
  const evening = sorted.find((b) => b.toMin === 1440 && b.fromMin > 0);
  const morning = sorted.find((b) => b.fromMin === 0 && b.toMin < 1440);
  if (!evening || !morning || evening.price !== morning.price || morning.toMin >= evening.fromMin) return sorted;
  return [
    ...sorted.filter((b) => b !== evening && b !== morning),
    { fromMin: evening.fromMin, toMin: morning.toMin, price: evening.price },
  ];
}

/** "Night" for the band that runs past midnight, "Day" for the other of a pair, "All day" for one. */
function labelFor(band: Band, bands: Band[]): string {
  if (band.toMin - band.fromMin >= 1440 || (band.fromMin === 0 && band.toMin === 1440)) return "All day";
  if (band.toMin < band.fromMin) return "Night";
  if (bands.length === 2 && bands.some((b) => b.toMin < b.fromMin)) return "Day";
  return "";
}

const sameCuts = (a: Band[], b: Band[]) =>
  a.length === b.length && a.every((x, i) => x.fromMin === b[i]!.fromMin && x.toMin === b[i]!.toMin);

function When({ band, bands }: { band: Band; bands: Band[] }) {
  const label = labelFor(band, bands);
  return (
    <td className="py-0.5 pr-2 text-ink-300">
      {label ? <span className="font-medium text-white">{label}</span> : null}
      {label && label !== "All day" ? " " : null}
      {label === "All day" ? null : <span className="whitespace-nowrap">{formatCompactRange(band.fromMin, band.toMin)}</span>}
    </td>
  );
}

const Price = ({ value }: { value: number }) => (
  <td className="py-0.5 pl-2 text-right font-semibold tabular-nums text-lime-400">{formatCurrency(value)}</td>
);

/**
 * What one facility costs, in the owner's own bands.
 *
 * Shared by the home-page showcase and the popup that opens before booking, so
 * a customer is quoted the same figures in both places — and both read the live
 * configuration rather than a copy written into the page.
 *
 * Kept to a line per price: the popup lists every facility at a ground, and a
 * customer should see all of them without scrolling. A weekend table with the
 * same hours as the weekday one becomes a second column rather than a second box.
 */
export function FacilityPricing({ facility }: { facility: Facility }) {
  const weekday = readable(facility.priceBands);
  const weekend = readable(facility.weekendBands ?? []);
  const hasWeekend = facility.kind !== "OVERS" && weekend.length > 0;
  const weekendDays = facility.weekendDays ?? [];
  const weekdayDays = WEEK_ORDER.filter((d) => !weekendDays.includes(d));
  const crossesMidnight = weekday.some((b) => b.toMin < b.fromMin) || weekend.some((b) => b.toMin < b.fromMin);

  return (
    <div className="rounded-xl border border-white/10 bg-ink-950 px-3.5 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <h4 className="text-[15px] font-bold text-white">{facility.name}</h4>
        <span className="text-xs text-ink-400">
          {formatCompactRange(facility.openMin, facility.closeMin)}
          {facility.resources.length > 1 ? ` · ${facility.resources.length} courts` : ""}
        </span>
      </div>

      {facility.kind === "OVERS" ? (
        <table className="mt-1.5 w-full text-sm">
          <tbody>
            {facility.ballTypes.map((ball) => (
              <tr key={ball.id}>
                <td className="py-0.5 pr-2 text-ink-300">{ball.name}</td>
                <td className="py-0.5 pl-2 text-right font-semibold tabular-nums text-lime-400">
                  {formatCurrency(ball.pricePerSlot)}
                  <span className="font-normal text-ink-400"> / {facility.oversPerSlot} overs</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : hasWeekend && sameCuts(weekday, weekend) ? (
        <table className="mt-1.5 w-full text-sm">
          <thead>
            <tr className="text-xs text-ink-400">
              <th className="pb-0.5 text-left font-normal">Per hour</th>
              <th className="pb-0.5 pl-2 text-right font-normal">{describeDays(weekdayDays)}</th>
              <th className="pb-0.5 pl-2 text-right font-normal">{describeDays(weekendDays)}</th>
            </tr>
          </thead>
          <tbody>
            {weekday.map((band, i) => (
              <tr key={band.fromMin}>
                <When band={band} bands={weekday} />
                <Price value={band.price} />
                <Price value={weekend[i]!.price} />
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <>
          {[
            { days: hasWeekend ? describeDays(weekdayDays) : "", bands: weekday },
            ...(hasWeekend ? [{ days: describeDays(weekendDays), bands: weekend }] : []),
          ].map((table) => (
            <table key={table.days || "all"} className="mt-1.5 w-full text-sm">
              {table.days ? (
                <thead>
                  <tr className="text-xs text-ink-400">
                    <th className="pb-0.5 text-left font-normal" colSpan={2}>
                      {table.days}
                    </th>
                  </tr>
                </thead>
              ) : null}
              <tbody>
                {table.bands.map((band) => (
                  <tr key={band.fromMin}>
                    <When band={band} bands={table.bands} />
                    <td className="py-0.5 pl-2 text-right font-semibold tabular-nums text-lime-400">
                      {formatCurrency(band.price)}
                      <span className="font-normal text-ink-400">/hr</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ))}
        </>
      )}

      {/* Said once, small: each hour is charged by its own date, so the hours after
          midnight take the next day's rate — Friday's late night is a Saturday hour. */}
      {hasWeekend && crossesMidnight ? (
        <p className="mt-1 text-[11px] text-ink-500">After midnight, the next day&apos;s rate applies.</p>
      ) : null}
    </div>
  );
}
