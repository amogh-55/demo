"use client";

import * as React from "react";
import Image from "next/image";
import Link from "next/link";
import { MapPin, Navigation, Phone } from "lucide-react";
import { locationPhotos } from "@/lib/photos";
import { formatCompactRange } from "@/lib/time";
import { Button, cn, formatCurrency } from "@/components/ui/primitives";
import type { PublicLocationTree } from "@/lib/catalog";

/**
 * One ground at a time: its photos, what it charges and how to get there.
 *
 * Tabbed rather than three long stacked blocks because the grounds sell
 * different things at different prices, and a customer deciding where to play
 * is comparing them — not reading all three.
 */
export function GroundsShowcase({ locations }: { locations: PublicLocationTree[] }) {
  const [activeId, setActiveId] = React.useState(locations[0]?.id ?? "");
  const active = locations.find((l) => l.id === activeId) ?? locations[0];

  if (!active) return null;

  const photos = locationPhotos(active.slug);

  return (
    <div>
      {/* Scrolls sideways on a phone rather than wrapping into a ragged block. */}
      <div className="-mx-4 mt-8 overflow-x-auto px-4 sm:mx-0 sm:px-0">
        <div role="tablist" aria-label="Our grounds" className="flex w-max gap-2 sm:w-auto sm:flex-wrap">
          {locations.map((l) => {
            const selected = l.id === active.id;
            return (
              <button
                key={l.id}
                role="tab"
                type="button"
                aria-selected={selected}
                onClick={() => setActiveId(l.id)}
                className={cn(
                  "whitespace-nowrap rounded-full border px-4 py-2 text-sm font-semibold transition-colors",
                  selected
                    ? "border-lime-400 bg-lime-400 text-ink-950"
                    : "border-white/15 bg-white/[0.04] text-ink-300 hover:border-lime-400/50 hover:text-white",
                )}
              >
                {l.name}
              </button>
            );
          })}
        </div>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        {/* ── Photos ────────────────────────────────────────────────── */}
        <div className="grid auto-rows-[130px] grid-cols-2 gap-3 sm:auto-rows-[170px]">
          {photos.map((photo, i) => (
            <div
              key={`${active.slug}-${photo.src}-${i}`}
              className={cn("relative overflow-hidden rounded-xl bg-ink-900", i === 0 ? "col-span-2" : "")}
            >
              <Image
                src={photo.src}
                alt={`${active.name} — ${photo.alt}`}
                fill
                sizes="(max-width: 1024px) 50vw, 25vw"
                className="object-cover transition-transform duration-500 hover:scale-105"
              />
            </div>
          ))}
        </div>

        {/* ── Pricing and details ───────────────────────────────────── */}
        <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
          <h3 className="text-xl font-bold text-white">{active.name}</h3>
          {active.description ? <p className="mt-1 text-sm text-ink-400">{active.description}</p> : null}

          <div className="mt-4 space-y-4">
            {active.facilities.map((f) => (
              <div key={f.id} className="rounded-xl border border-white/10 bg-ink-950 p-4">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <h4 className="font-bold text-white">{f.name}</h4>
                  <span className="text-xs text-ink-400">
                    {formatCompactRange(f.openMin, f.closeMin)}
                    {f.resources.length > 1 ? ` · ${f.resources.length} courts` : ""}
                  </span>
                </div>

                {/* The owner's own bands, read from the same configuration the
                    booking engine charges from — so a rate change in the admin
                    panel updates this table too. */}
                <dl className="mt-3 space-y-1.5 text-sm">
                  {f.kind === "OVERS"
                    ? f.ballTypes.map((b) => (
                        <div key={b.id} className="flex items-baseline justify-between gap-3">
                          <dt className="text-ink-400">{b.name}</dt>
                          <dd className="font-semibold text-lime-400">
                            {formatCurrency(b.pricePerSlot)}
                            <span className="text-ink-400"> / {f.oversPerSlot} overs</span>
                          </dd>
                        </div>
                      ))
                    : f.priceBands.map((band) => (
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
            ))}
          </div>

          <div className="mt-5 space-y-2 text-sm text-ink-400">
            {active.address ? (
              <p className="flex items-start gap-2">
                <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-lime-400" aria-hidden="true" />
                <span className="break-words">{active.address}</span>
              </p>
            ) : null}
            {active.phone ? (
              <p className="flex items-center gap-2">
                <Phone className="h-4 w-4 shrink-0 text-lime-400" aria-hidden="true" />
                <a href={`tel:+91${active.phone}`} className="hover:text-white">
                  +91 {active.phone}
                </a>
              </p>
            ) : null}
            {active.mapsUrl ? (
              <a
                href={active.mapsUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 font-medium text-lime-400 hover:text-lime-300"
              >
                <Navigation className="h-4 w-4" aria-hidden="true" />
                Open in Google Maps
              </a>
            ) : null}
          </div>

          <Link href={`/book?location=${active.slug}`} className="mt-5 block">
            <Button className="w-full">Book {active.name}</Button>
          </Link>
        </div>
      </div>
    </div>
  );
}
