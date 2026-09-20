import type { Metadata } from "next";
import { collections, getDb } from "@/lib/db";
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
  const locations = await collections.locations(db).find({}).sort({ name: 1 }).toArray();

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <div>
        <h1 className="text-xl font-bold text-ink-900">Bookings</h1>
        <p className="text-sm text-ink-600">Verify payments, accept or reject requests.</p>
      </div>

      <BookingsManager
        locations={locations.map((l) => ({ id: l._id.toHexString(), name: l.name }))}
        initialFilters={filters}
      />
    </div>
  );
}
