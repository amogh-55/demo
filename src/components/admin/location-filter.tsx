"use client";

import * as React from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Spinner } from "@/components/ui/primitives";
import { cn } from "@/components/ui/primitives";

/**
 * Scopes a server-rendered admin page to one ground.
 *
 * The choice lives in the URL rather than in component state, so the page stays a
 * server component, a filtered view can be bookmarked or sent to someone, and a
 * refresh keeps the ground the staff member was looking at.
 *
 * It wraps the page body on purpose. The figures below come from the server, so
 * between picking a ground and the new numbers arriving they still belong to the
 * previous one — and a dropdown reading "Medpally" above Uppal's totals is worse
 * than a short wait. While the navigation is in flight the body is dimmed and
 * marked busy, so the numbers are never read as belonging to the new selection.
 */
export function LocationFilter({
  locations,
  value,
  label = "Ground",
  children,
}: {
  locations: Array<{ id: string; name: string }>;
  value: string;
  label?: string;
  children?: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [isPending, startTransition] = React.useTransition();
  const [target, setTarget] = React.useState<string | null>(null);

  // The transition ends once the server's payload has rendered, which is the only
  // moment the select and the figures below are known to agree again.
  React.useEffect(() => {
    if (!isPending) setTarget(null);
  }, [isPending]);

  if (locations.length < 2) return <>{children}</>;

  const shown = target ?? value;

  return (
    <>
      <div className="w-full sm:w-64">
        <label className="field-label flex items-center gap-2" htmlFor="ground-filter">
          {label}
          {isPending ? (
            <span className="inline-flex items-center gap-1 text-xs font-normal text-ink-500">
              <Spinner /> updating…
            </span>
          ) : null}
        </label>
        <select
          id="ground-filter"
          className="field-input"
          value={shown}
          disabled={isPending}
          onChange={(event) => {
            const next = event.target.value;
            setTarget(next);
            const query = new URLSearchParams(params.toString());
            if (next) query.set("locationId", next);
            else query.delete("locationId");
            const search = query.toString();
            startTransition(() => router.push(search ? `${pathname}?${search}` : pathname));
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

      {children !== undefined ? (
        <div
          aria-busy={isPending}
          className={cn("transition-opacity", isPending && "pointer-events-none opacity-40")}
        >
          {children}
        </div>
      ) : null}
    </>
  );
}
