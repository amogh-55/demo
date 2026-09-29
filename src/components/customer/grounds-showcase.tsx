"use client";

import * as React from "react";
import Image from "next/image";
import * as Dialog from "@radix-ui/react-dialog";
import { ChevronLeft, ChevronRight, MapPin, Navigation, Phone, X } from "lucide-react";
import { groundTitle } from "@/lib/ground-titles";
import { locationPhotos, type GalleryPhoto } from "@/lib/photos";
import { FacilityPricing } from "@/components/customer/facility-pricing";
import { GroundDialog } from "@/components/customer/ground-dialog";
import { cn } from "@/components/ui/primitives";
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
  const [viewing, setViewing] = React.useState<number | null>(null);
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
                {groundTitle(l)}
              </button>
            );
          })}
        </div>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        {/* ── Photos ────────────────────────────────────────────────── */}
        {/* The first row is a little taller so the lead photo shows the whole cage.
            A tap opens any photo full screen. */}
        <div className="grid auto-rows-[130px] grid-cols-2 grid-rows-[170px] gap-3 sm:auto-rows-[170px] sm:grid-rows-[230px]">
          {photos.map((photo, i) => (
            <button
              key={`${active.slug}-${photo.src}-${i}`}
              type="button"
              onClick={() => setViewing(i)}
              aria-label={`Open photo ${i + 1} of ${photos.length}: ${photo.alt}`}
              className={cn("relative overflow-hidden rounded-xl bg-ink-900", i === 0 ? "col-span-2" : "")}
            >
              <Image
                src={photo.src}
                alt={`${groundTitle(active)} — ${photo.alt}`}
                fill
                sizes="(max-width: 1024px) 50vw, 25vw"
                className="object-cover transition-transform duration-500 hover:scale-105"
              />
            </button>
          ))}
        </div>

        {/* ── Pricing and details ───────────────────────────────────── */}
        <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
          <h3 className="text-2xl font-bold text-white">{groundTitle(active)}</h3>
          {active.description ? <p className="mt-1 text-sm text-ink-400">{active.description}</p> : null}

          <div className="mt-4 space-y-4">
            {active.facilities.map((f) => (
              <FacilityPricing key={f.id} facility={f} />
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

          <div className="mt-5">
            <GroundDialog location={active} label={`Book ${groundTitle(active)}`} />
          </div>
        </div>
      </div>

      <PhotoViewer title={groundTitle(active)} photos={photos} index={viewing} onIndex={setViewing} />
    </div>
  );
}

/**
 * One photo full screen, with previous and next.
 *
 * Arrow keys on a laptop, a sideways swipe on a phone, and it wraps round at
 * either end so there is never a dead button.
 */
function PhotoViewer({
  title,
  photos,
  index,
  onIndex,
}: {
  title: string;
  photos: GalleryPhoto[];
  index: number | null;
  onIndex: (index: number | null) => void;
}) {
  const touchX = React.useRef<number | null>(null);
  const photo = index === null ? null : photos[index];
  const step = (by: number) => index !== null && onIndex((index + by + photos.length) % photos.length);

  return (
    <Dialog.Root open={photo !== null} onOpenChange={(open) => (open ? null : onIndex(null))}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed inset-0 z-50 flex flex-col focus:outline-none"
          onKeyDown={(e) => {
            if (e.key === "ArrowRight") step(1);
            if (e.key === "ArrowLeft") step(-1);
          }}
        >
          <div className="flex items-center justify-between gap-3 px-4 py-3">
            <Dialog.Title className="min-w-0 truncate text-sm font-semibold text-white">
              {title}
              <span className="ml-2 font-normal text-ink-400 tabular-nums">
                {index === null ? "" : `${index + 1} / ${photos.length}`}
              </span>
            </Dialog.Title>
            <Dialog.Close
              className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-white hover:bg-white/10"
              aria-label="Close"
            >
              <X className="h-6 w-6" />
            </Dialog.Close>
          </div>

          <div
            className="relative min-h-0 flex-1"
            onTouchStart={(e) => {
              touchX.current = e.touches[0]?.clientX ?? null;
            }}
            onTouchEnd={(e) => {
              const from = touchX.current;
              const to = e.changedTouches[0]?.clientX;
              touchX.current = null;
              if (from === null || to === undefined || Math.abs(to - from) < 40) return;
              step(to < from ? 1 : -1);
            }}
          >
            {photo ? (
              <Image key={index} src={photo.src} alt={photo.alt} fill sizes="100vw" className="object-contain" />
            ) : null}
            {photos.length > 1 ? (
              <>
                <button
                  type="button"
                  onClick={() => step(-1)}
                  aria-label="Previous photo"
                  className="absolute left-2 top-1/2 grid h-11 w-11 -translate-y-1/2 place-items-center rounded-full bg-black/50 text-white hover:bg-black/70"
                >
                  <ChevronLeft className="h-6 w-6" />
                </button>
                <button
                  type="button"
                  onClick={() => step(1)}
                  aria-label="Next photo"
                  className="absolute right-2 top-1/2 grid h-11 w-11 -translate-y-1/2 place-items-center rounded-full bg-black/50 text-white hover:bg-black/70"
                >
                  <ChevronRight className="h-6 w-6" />
                </button>
              </>
            ) : null}
          </div>

          <p className="px-4 pb-[calc(1rem_+_env(safe-area-inset-bottom))] pt-3 text-center text-sm text-ink-300">
            {photo?.alt}
          </p>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
