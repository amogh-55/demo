import type { Metadata } from "next";
import { collections, getDb } from "@/lib/db";
import { LocationsManager } from "@/components/admin/locations-manager";
import { EmptyState } from "@/components/ui/primitives";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Locations", robots: { index: false } };

export default async function AdminLocationsPage() {
  const db = await getDb();
  /**
   * Facilities and courts are fetched here rather than by the client after it
   * mounts. They used to arrive a round-trip late, so every visit to this tab
   * showed "0 facilities" under every ground for as long as that took and then
   * silently corrected itself — which reads as data loss, not as loading.
   */
  const [locations, facilities, resources] = await Promise.all([
    collections.locations(db).find({}).sort({ name: 1 }).toArray(),
    collections.facilities(db).find({}).sort({ sortOrder: 1, name: 1 }).toArray(),
    collections.resources(db).find({}).sort({ sortOrder: 1, name: 1 }).toArray(),
  ]);

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <div>
        <h1 className="text-xl font-bold text-ink-900">Locations</h1>
        <p className="text-sm text-ink-600">
          Grounds, what each one sells, and the hours and prices for every facility.
        </p>
      </div>

      {locations.length === 0 ? (
        <EmptyState title="No locations yet." hint="Run the seed script to create the grounds." />
      ) : (
        <LocationsManager
          initialTree={{
            facilities: facilities.map((f) => ({
              id: f._id.toHexString(),
              locationId: f.locationId.toHexString(),
              name: f.name,
              slug: f.slug,
              kind: f.kind,
              description: f.description,
              sortOrder: f.sortOrder,
              active: f.active,
              config: f.config,
            })),
            resources: resources.map((r) => ({
              id: r._id.toHexString(),
              locationId: r.locationId.toHexString(),
              facilityId: r.facilityId.toHexString(),
              name: r.name,
              slug: r.slug,
              sortOrder: r.sortOrder,
              active: r.active,
            })),
          }}
          initialLocations={locations.map((l) => ({
            id: l._id.toHexString(),
            name: l.name,
            slug: l.slug,
            address: l.address,
            mapsUrl: l.mapsUrl ?? "",
            description: l.description,
            image: l.image,
            phone: l.phone,
            active: l.active,
          }))}
        />
      )}
    </div>
  );
}
