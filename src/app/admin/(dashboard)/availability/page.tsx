import type { Metadata } from "next";
import { collections, getDb } from "@/lib/db";
import { istDateString } from "@/lib/time";
import { AvailabilityManager } from "@/components/admin/availability-manager";
import { EmptyState } from "@/components/ui/primitives";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Availability", robots: { index: false } };

export default async function AdminAvailabilityPage() {
  const db = await getDb();
  const [locations, facilities, resources] = await Promise.all([
    collections.locations(db).find({}).sort({ name: 1 }).toArray(),
    collections.facilities(db).find({}).sort({ sortOrder: 1, name: 1 }).toArray(),
    collections.resources(db).find({}).sort({ sortOrder: 1, name: 1 }).toArray(),
  ]);

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <div>
        <h1 className="text-xl font-bold text-ink-900">Availability</h1>
        <p className="text-sm text-ink-600">Block slots for tournaments or maintenance, and re-open them later.</p>
      </div>

      {facilities.length === 0 ? (
        <EmptyState title="Nothing to manage yet." hint="Add a facility under Locations first." />
      ) : (
        <AvailabilityManager
          today={istDateString()}
          locations={locations.map((l) => ({ id: l._id.toHexString(), name: l.name }))}
          facilities={facilities.map((f) => ({
            id: f._id.toHexString(),
            locationId: f.locationId.toHexString(),
            name: f.name,
            resources: resources
              .filter((r) => r.facilityId.equals(f._id))
              .map((r) => ({ id: r._id.toHexString(), name: r.name })),
          }))}
        />
      )}
    </div>
  );
}
