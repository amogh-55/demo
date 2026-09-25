"use client";

import * as React from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Spinner } from "@/components/ui/primitives";
import { cn } from "@/components/ui/primitives";

/**
 * Tapping a ground adds it to the selection or takes it out. "All grounds" —
 * and picking every ground, or none — is the empty selection, so there is one
 * way to write "everything" in a URL. Ids stay in the list's own order, so the
 * same grounds always make the same query.
 */
export function toggleGround(value: string, id: string, allIds: string[]): string {
  if (!id) return "";
  const picked = new Set(value.split(",").filter(Boolean));
  if (picked.has(id)) picked.delete(id);
  else picked.add(id);
  const next = allIds.filter((g) => picked.has(g));
  return next.length === allIds.length ? "" : next.join(",");
}

/**
 * The grounds as small buttons that all fit across a phone, with no sideways
 * scrolling; one or several can be on at once. `value` is the comma-joined ids,
 * "" for all.
 */
export function GroundChips({
  locations,
  value,
  onChange,
  busy = false,
  label = "Ground",
}: {
  locations: Array<{ id: string; name: string }>;
  value: string;
  onChange: (next: string) => void;
  busy?: boolean;
  label?: string;
}) {
  const picked = value.split(",").filter(Boolean);
  const allIds = locations.map((l) => l.id);
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-1.5">
      {[{ id: "", name: "All grounds" }, ...locations].map((ground) => {
        const on = ground.id ? picked.includes(ground.id) : picked.length === 0;
        return (
          <button
            key={ground.id || "all"}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(toggleGround(value, ground.id, allIds))}
            className={cn(
              "flex h-9 flex-[1_0_auto] items-center justify-center gap-1.5 rounded-lg px-2 text-xs font-semibold transition-colors sm:h-10 sm:flex-none sm:px-4 sm:text-sm",
              on ? "bg-pitch-600 text-white shadow-sm" : "bg-white text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-50",
            )}
          >
            {/* "All" on a phone is what lets four grounds fit on one row; it is
                still "All grounds" to a screen reader and on a wider screen. */}
            {ground.id ? ground.name : <span>All<span className="sr-only sm:not-sr-only"> grounds</span></span>}
            {on && busy ? <Spinner className="text-current" /> : null}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Scopes a server-rendered admin page to one or more grounds.
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

  const choose = (next: string) => {
    if (next === shown) return;
    setTarget(next);
    const query = new URLSearchParams(params.toString());
    if (next) query.set("locationId", next);
    else query.delete("locationId");
    const search = query.toString();
    startTransition(() => router.push(search ? `${pathname}?${search}` : pathname));
  };

  return (
    <>
      <GroundChips locations={locations} value={shown} onChange={choose} busy={isPending} label={label} />

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
