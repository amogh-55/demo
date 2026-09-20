"use client";

import * as React from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

/**
 * Scopes a server-rendered admin page to one ground.
 *
 * The choice lives in the URL rather than in component state, so the page can stay
 * a server component, a filtered view can be bookmarked or sent to someone, and a
 * refresh keeps the ground the staff member was looking at.
 */
export function LocationFilter({
  locations,
  value,
  label = "Ground",
}: {
  locations: Array<{ id: string; name: string }>;
  value: string;
  label?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pendingValue, setPendingValue] = React.useState<string | null>(null);

  // Clear the optimistic value once the server has caught up.
  React.useEffect(() => setPendingValue(null), [value]);

  if (locations.length < 2) return null;

  const shown = pendingValue ?? value;

  return (
    <div className="w-full sm:w-64">
      <label className="field-label" htmlFor="ground-filter">
        {label}
      </label>
      <select
        id="ground-filter"
        className="field-input"
        value={shown}
        onChange={(event) => {
          const next = event.target.value;
          // Moves immediately, rather than after the round trip to MongoDB.
          setPendingValue(next);
          const query = new URLSearchParams(params.toString());
          if (next) query.set("locationId", next);
          else query.delete("locationId");
          const search = query.toString();
          router.push(search ? `${pathname}?${search}` : pathname);
        }}
      >
        <option value="">All grounds</option>
        {locations.map((l) => (
          <option key={l.id} value={l.id}>
            {l.name}
          </option>
        ))}
      </select>
    </div>
  );
}
