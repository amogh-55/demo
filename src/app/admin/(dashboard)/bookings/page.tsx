import type { Metadata } from "next";
import { listBookings } from "@/lib/booking/admin-list";
import { collections, getDb } from "@/lib/db";
import { istDateString } from "@/lib/time";
import { adminBookingsQuerySchema } from "@/lib/validation";
import { BookingsManager } from "@/components/admin/bookings-manager";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Bookings", robots: { index: false } };

export default async function AdminBookingsPage({
  searchParams,
}: {
  searchParams: Promise<{
    locationId?: string;
    date?: string;
    tab?: string;
    status?: string;
    payment?: string;
    search?: string;
    sport?: string;
  }>;
}) {
  const filters = await searchParams;
  const db = await getDb();
  const [locations, sports, initialList] = await Promise.all([
    collections.locations(db).find({}).sort({ name: 1 }).toArray(),
    // Every service name, retired ones included: their bookings still need finding.
    collections.facilities(db).distinct("name"),
    // The first page of the list, rendered here rather than fetched by the
    // browser once it has mounted. That fetch was a second round trip the owner
    // waited through as a skeleton, after already waiting for this one.
    /*
     * Parsed through the same schema the API uses, but leniently: a shared link
     * carrying "?status=BANANA" should show the unfiltered list, not replace the
     * whole admin panel with a server error. The API still answers 400 for the
     * same input, because that one is a request rather than a page.
     */
    listBookings({ ...(adminBookingsQuerySchema.safeParse(filters).data ?? {}), page: 1 }),
  ]);

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <BookingsManager
        // A link that changes the filters — a dashboard card —
        // has to start the list over; without the key the open list keeps its
        // own state and the tap appears to do nothing.
        key={JSON.stringify(filters)}
        locations={locations.map((l) => ({ id: l._id.toHexString(), name: l.name }))}
        today={istDateString()}
        sports={(sports as string[]).sort()}
        initialFilters={filters}
        initialList={initialList}
      />
    </div>
  );
}
