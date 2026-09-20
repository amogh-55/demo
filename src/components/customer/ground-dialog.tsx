"use client";

import * as React from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useRouter } from "next/navigation";
import { ArrowRight, MapPin, X } from "lucide-react";
import { FacilityPricing } from "@/components/customer/facility-pricing";
import { Button, Spinner, cn } from "@/components/ui/primitives";
import type { PublicLocationTree } from "@/lib/catalog";

/**
 * "Book this ground" now answers the two questions a customer asks before they
 * commit — what does this ground have, and what does it cost — instead of
 * sending them to a page to find out.
 *
 * It also fixes how the old link felt. Tapping it started a server render with
 * nothing on screen but the browser's own spinner, so on a phone it read as a
 * dead button. The popup opens instantly, the booking page is prefetched while
 * the customer reads it, and Continue shows its own progress.
 */
export function GroundDialog({
  location,
  label = "Book this ground",
  className,
}: {
  location: PublicLocationTree;
  label?: string;
  className?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [going, setGoing] = React.useState(false);
  const href = `/book?location=${location.slug}`;

  // Warm the booking page while the popup is being read, so Continue lands on a
  // page that is already built rather than starting one.
  React.useEffect(() => {
    if (open) router.prefetch(href);
  }, [open, href, router]);

  return (
    <Dialog.Root open={open} onOpenChange={(next) => (going ? null : setOpen(next))}>
      <Dialog.Trigger asChild>
        <Button className={cn("w-full", className)}>{label}</Button>
      </Dialog.Trigger>

      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-ink-950/70 backdrop-blur-sm" />
        <Dialog.Content
          className="fixed bottom-0 left-1/2 z-50 flex max-h-[85dvh] w-full max-w-lg -translate-x-1/2 flex-col rounded-t-2xl border border-white/10 bg-ink-900 focus:outline-none sm:bottom-auto sm:top-1/2 sm:-translate-y-1/2 sm:rounded-2xl"
          aria-describedby={undefined}
        >
          <div className="flex items-start justify-between gap-3 border-b border-white/10 p-5 pb-4">
            <div className="min-w-0">
              <Dialog.Title className="text-lg font-bold text-white">{location.name}</Dialog.Title>
              {location.address ? (
                <p className="mt-1 flex items-start gap-1.5 text-sm text-ink-400">
                  <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-lime-400" aria-hidden="true" />
                  <span className="break-words">{location.address}</span>
                </p>
              ) : null}
            </div>
            <Dialog.Close
              className="-mr-1 -mt-1 grid h-9 w-9 shrink-0 place-items-center rounded-full text-ink-400 hover:bg-white/10 hover:text-white"
              aria-label="Close"
            >
              <X className="h-5 w-5" />
            </Dialog.Close>
          </div>

          {/* Scrolls on its own so the Continue button never leaves the screen. */}
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-5">
            {location.facilities.map((facility) => (
              <FacilityPricing key={facility.id} facility={facility} />
            ))}
          </div>

          <div className="border-t border-white/10 p-5 pb-[calc(1.25rem_+_env(safe-area-inset-bottom))]">
            <Button
              size="lg"
              className="w-full"
              disabled={going}
              onClick={() => {
                setGoing(true);
                router.push(href);
              }}
            >
              {going ? <Spinner /> : null}
              {going ? "Opening availability…" : "Continue"}
              {going ? null : <ArrowRight className="h-5 w-5" aria-hidden="true" />}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
