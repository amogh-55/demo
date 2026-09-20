import type { Metadata } from "next";
import { collections, getDb } from "@/lib/db";
import { LocationsManager } from "@/components/admin/locations-manager";
import { EmptyState } from "@/components/ui/primitives";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Locations", robots: { index: false } };

export default async function AdminLocationsPage() {
  const db = await getDb();
  const locations = await collections.locations(db).find({}).sort({ name: 1 }).toArray();

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
