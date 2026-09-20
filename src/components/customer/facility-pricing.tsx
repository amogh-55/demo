import { formatCompactRange } from "@/lib/time";
import { formatCurrency } from "@/components/ui/primitives";
import type { PublicLocationTree } from "@/lib/catalog";

type Facility = PublicLocationTree["facilities"][number];

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

function BandList({ bands }: { bands: Facility["priceBands"] }) {
  return (
    <dl className="space-y-1.5 text-sm">
      {bands.map((band) => (
        <div key={band.fromMin} className="flex items-baseline justify-between gap-3">
          <dt className="text-ink-400">{formatCompactRange(band.fromMin, band.toMin)}</dt>
          <dd className="font-semibold text-lime-400">
            {formatCurrency(band.price)}
            <span className="text-ink-400">/hr</span>
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * What one facility costs, in the owner's own bands.
 *
 * Shared by the home-page showcase and the popup that opens before booking, so
 * a customer is quoted the same figures in both places — and both read the live
 * configuration rather than a copy written into the page.
 *
 * A ground that charges more at the weekend gets two tables side by side, which
 * is how the price list is read out on the phone and painted on the board: the
 * customer wants to know what Saturday costs, not to work it out.
 */
export function FacilityPricing({ facility }: { facility: Facility }) {
  const weekendBands = facility.weekendBands ?? [];
  const hasWeekend = facility.kind !== "OVERS" && weekendBands.length > 0;
  const weekendDays = facility.weekendDays ?? [];
  const weekdayDays = WEEK_ORDER.filter((d) => !weekendDays.includes(d));

  return (
    <div className="rounded-xl border border-white/10 bg-ink-950 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h4 className="font-bold text-white">{facility.name}</h4>
        <span className="text-xs text-ink-400">
          {formatCompactRange(facility.openMin, facility.closeMin)}
          {facility.resources.length > 1 ? ` · ${facility.resources.length} courts` : ""}
        </span>
      </div>

      {facility.kind === "OVERS" ? (
        <dl className="mt-3 space-y-1.5 text-sm">
          {facility.ballTypes.map((ball) => (
            <div key={ball.id} className="flex items-baseline justify-between gap-3">
              <dt className="text-ink-400">{ball.name}</dt>
              <dd className="font-semibold text-lime-400">
                {formatCurrency(ball.pricePerSlot)}
                <span className="text-ink-400"> / {facility.oversPerSlot} overs</span>
              </dd>
            </div>
          ))}
        </dl>
      ) : hasWeekend ? (
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div className="rounded-lg border border-white/10 p-3">
            <p className="mb-2 flex items-baseline justify-between gap-2">
              <span className="text-sm font-semibold text-white">Weekdays</span>
              <span className="text-xs text-ink-400">{describeDays(weekdayDays)}</span>
            </p>
            <BandList bands={facility.priceBands} />
          </div>
          <div className="rounded-lg border border-lime-400/30 bg-lime-400/[0.04] p-3">
            <p className="mb-2 flex items-baseline justify-between gap-2">
              <span className="text-sm font-semibold text-white">Weekends</span>
              <span className="text-xs text-lime-400/80">{describeDays(weekendDays)}</span>
            </p>
            <BandList bands={weekendBands} />
          </div>
        </div>
      ) : (
        <div className="mt-3">
          <BandList bands={facility.priceBands} />
        </div>
      )}
    </div>
  );
}
