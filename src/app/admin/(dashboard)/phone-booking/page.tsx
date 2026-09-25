import type { Metadata } from "next";
import { collections, getDb } from "@/lib/db";
import { istDateString } from "@/lib/time";
import { EmptyState } from "@/components/ui/primitives";
import { PhoneBookingForm } from "@/components/admin/phone-booking-form";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Phone booking", robots: { index: false } };

export default async function AdminPhoneBookingPage() {
  const db = await getDb();
  // Only ACTIVE things can still be sold, over the phone as much as online.
  const [locations, facilities, resources] = await Promise.all([
    collections.locations(db).find({}).sort({ name: 1 }).toArray(),
    collections.facilities(db).find({ active: true }).sort({ sortOrder: 1, name: 1 }).toArray(),
    collections.resources(db).find({ active: true }).sort({ sortOrder: 1, name: 1 }).toArray(),
  ]);

  const bookable = facilities
    .map((f) => ({
      id: f._id.toHexString(),
      locationId: f.locationId.toHexString(),
      name: f.name,
      kind: f.kind,
      oversPerSlot: f.config.oversPerSlot,
      ballTypes: f.config.ballTypes.map((b) => ({ id: b.id, name: b.name, pricePerSlot: b.pricePerSlot })),
      resources: resources
        .filter((r) => r.facilityId.equals(f._id))
        .map((r) => ({ id: r._id.toHexString(), name: r.name })),
    }))
    // A service with no court under it cannot be booked by anyone, staff included.
    .filter((f) => f.resources.length > 0);

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-ink-900">Phone booking</h1>
        <p className="text-sm text-ink-600">Confirmed as soon as you add it, and the slot comes off the website.</p>
      </div>

      {bookable.length === 0 ? (
        <EmptyState title="Nothing to book yet." hint="Add a ground and a facility under Settings first." />
      ) : (
        <PhoneBookingForm
          // Only grounds with something to sell, so the first one picked is never empty.
          locations={locations
            .map((l) => ({ id: l._id.toHexString(), name: l.name }))
            .filter((l) => bookable.some((f) => f.locationId === l.id))}
          facilities={bookable}
          today={istDateString()}
        />
      )}
    </div>
  );
}
