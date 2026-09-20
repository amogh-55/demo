import type { Metadata } from "next";
import { collections, getDb } from "@/lib/db";
import { istDateString } from "@/lib/time";
import { BookingsManager } from "@/components/admin/bookings-manager";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Bookings", robots: { index: false } };

export default async function AdminBookingsPage({
  searchParams,
}: {
  searchParams: Promise<{ locationId?: string; date?: string; status?: string; payment?: string; search?: string }>;
}) {
  const filters = await searchParams;
  const db = await getDb();
  // The whole catalogue, because a booking taken over the phone can be for
  // anything the grounds sell — and only ACTIVE things can still be sold.
  const [locations, facilities, resources] = await Promise.all([
    collections.locations(db).find({}).sort({ name: 1 }).toArray(),
    collections.facilities(db).find({ active: true }).sort({ sortOrder: 1, name: 1 }).toArray(),
    collections.resources(db).find({ active: true }).sort({ sortOrder: 1, name: 1 }).toArray(),
  ]);

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <BookingsManager
        locations={locations.map((l) => ({ id: l._id.toHexString(), name: l.name }))}
        today={istDateString()}
        facilities={facilities
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
          .filter((f) => f.resources.length > 0)}
        initialFilters={filters}
      />
    </div>
  );
}
