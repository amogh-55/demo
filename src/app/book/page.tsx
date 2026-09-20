import Link from "next/link";
import type { Metadata } from "next";
import { ArrowLeft } from "lucide-react";
import { collections, getDb } from "@/lib/db";
import { DEFAULT_SLOT_CONFIG } from "@/lib/booking/service";
import { istDateString } from "@/lib/time";
import { getSettings } from "@/lib/settings";
import { BookingFlow } from "@/components/customer/booking-flow";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Book a slot",
  description: "Check live availability and book a cricket turf slot.",
};

export default async function BookPage({ searchParams }: { searchParams: Promise<{ location?: string }> }) {
  const { location } = await searchParams;
  const db = await getDb();

  const [locations, settings, configs] = await Promise.all([
    collections.locations(db).find({ active: true }).sort({ name: 1 }).toArray(),
    getSettings(),
    collections.slotConfigs(db).find({}).toArray(),
  ]);

  // The date picker's bounds come from the server in the business timezone. The
  // widest configured window is used so the picker never hides a date some ground
  // genuinely accepts; the availability API still enforces each location's own limit.
  const bookingWindowDays = configs.length
    ? Math.max(...configs.map((c) => c.bookingWindowDays))
    : DEFAULT_SLOT_CONFIG.bookingWindowDays;

  return (
    <div className="min-h-dvh bg-ink-950">
      <header className="border-b border-white/10 bg-ink-950/90 backdrop-blur">
        <div className="container flex h-16 items-center justify-between gap-3">
          <Link
            href="/"
            className="-ml-2 flex min-h-[44px] shrink-0 items-center gap-2 px-2 text-sm font-medium text-ink-300 hover:text-lime-400"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            Back
          </Link>
          {/* Truncates rather than shoving "Back" off the left edge of a 320px screen. */}
          <p className="truncate text-sm font-extrabold uppercase tracking-tight text-white">{settings.businessName}</p>
        </div>
      </header>

      <main id="main" className="container max-w-3xl py-6 sm:py-10">
        <h1 className="text-3xl font-extrabold uppercase tracking-tight text-white sm:text-4xl">Book your slot</h1>
        <p className="mt-2 text-ink-400">No account needed. Pick a slot, pay by UPI and we will confirm on WhatsApp.</p>

        <div className="mt-6">
          <BookingFlow
            initialLocationSlug={location}
            today={istDateString()}
            bookingWindowDays={bookingWindowDays}
            locations={locations.map((l) => ({
              id: l._id.toHexString(),
              name: l.name,
              slug: l.slug,
              address: l.address,
              description: l.description,
              image: l.image,
            }))}
            payment={{
              businessName: settings.businessName,
              upiId: settings.upiId,
              upiPayeeName: settings.upiPayeeName,
              upiQrImageUrl: settings.upiQrImageUrl,
              supportPhone: settings.supportPhone,
            }}
          />
        </div>
      </main>
    </div>
  );
}
