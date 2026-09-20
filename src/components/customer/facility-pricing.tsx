import { formatCompactRange } from "@/lib/time";
import { formatCurrency } from "@/components/ui/primitives";
import type { PublicLocationTree } from "@/lib/catalog";

type Facility = PublicLocationTree["facilities"][number];

/**
 * What one facility costs, in the owner's own bands.
 *
 * Shared by the home-page showcase and the popup that opens before booking, so
 * a customer is quoted the same figures in both places — and both read the live
 * configuration rather than a copy written into the page.
 */
export function FacilityPricing({ facility }: { facility: Facility }) {
  return (
    <div className="rounded-xl border border-white/10 bg-ink-950 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h4 className="font-bold text-white">{facility.name}</h4>
        <span className="text-xs text-ink-400">
          {formatCompactRange(facility.openMin, facility.closeMin)}
          {facility.resources.length > 1 ? ` · ${facility.resources.length} courts` : ""}
        </span>
      </div>

      <dl className="mt-3 space-y-1.5 text-sm">
        {facility.kind === "OVERS"
          ? facility.ballTypes.map((ball) => (
              <div key={ball.id} className="flex items-baseline justify-between gap-3">
                <dt className="text-ink-400">{ball.name}</dt>
                <dd className="font-semibold text-lime-400">
                  {formatCurrency(ball.pricePerSlot)}
                  <span className="text-ink-400"> / {facility.oversPerSlot} overs</span>
                </dd>
              </div>
            ))
          : facility.priceBands.map((band) => (
              <div key={band.fromMin} className="flex items-baseline justify-between gap-3">
                <dt className="text-ink-400">{formatCompactRange(band.fromMin, band.toMin)}</dt>
                <dd className="font-semibold text-lime-400">
                  {formatCurrency(band.price)}
                  <span className="text-ink-400">/hr</span>
                </dd>
              </div>
            ))}
      </dl>
    </div>
  );
}
