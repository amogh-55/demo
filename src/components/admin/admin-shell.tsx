"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { CalendarRange, ClipboardList, LayoutDashboard, LogOut, PhoneCall, Settings } from "lucide-react";
import { api } from "@/lib/client";
import { Button, Spinner, cn } from "@/components/ui/primitives";

/** Mirrors the server session shape; kept local so this client file never imports server code. */
interface AdminSessionView {
  username: string;
  displayName: string;
}

/**
 * `short` exists because a five-column tab bar on a 360px phone cannot fit "Availability".
 *
 * One order everywhere, and it puts Bookings — the tab opened all day — in the
 * middle of the phone bar, the easiest target one-handed. Grounds and prices
 * live under Settings: they are set up once and rarely touched, which is no
 * claim on a tab of their own.
 */
const NAV = [
  { href: "/admin", label: "Dashboard", short: "Home", icon: LayoutDashboard },
  { href: "/admin/phone-booking", label: "Phone booking", short: "Phone", icon: PhoneCall },
  { href: "/admin/bookings", label: "Bookings", short: "Bookings", icon: ClipboardList },
  { href: "/admin/availability", label: "Availability", short: "Slots", icon: CalendarRange },
  { href: "/admin/settings", label: "Settings", short: "Settings", icon: Settings },
];

/** A turf seen from above: the brand mark on the sidebar and the phone header. */
function PitchMark({ className }: { className?: string }) {
  return (
    <span className={cn("grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-pitch-600 text-white shadow-sm", className)}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-5 w-5" aria-hidden="true">
        <rect x="2.5" y="5" width="19" height="14" rx="2" />
        <path d="M12 5v14M2.5 9.5H5v5H2.5M21.5 9.5H19v5h2.5" />
        <circle cx="12" cy="12" r="2.5" />
      </svg>
    </span>
  );
}

/** Sidebar on desktop, bottom tab bar on phones — the owner reviews bookings on mobile. */
export function AdminShell({ session, children }: { session: AdminSessionView; children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [signingOut, setSigningOut] = React.useState(false);

  async function signOut() {
    setSigningOut(true);
    try {
      await api("/api/admin/logout", { method: "POST" });
    } finally {
      router.replace("/admin/login");
      router.refresh();
    }
  }

  const isActive = (href: string) => (href === "/admin" ? pathname === "/admin" : pathname.startsWith(href));

  /**
   * Every admin page is server-rendered against the database, so a tab tap has a
   * real round-trip behind it and needs to answer immediately.
   *
   * It answers by marking the tapped tab as BUSY — not by moving the highlight.
   * Moving it was a lie the screen could get stuck inside: tap quickly between
   * tabs and the highlight belonged to a page that was cancelled on the way,
   * leaving Settings lit above the bookings list. The highlight now only ever
   * says where you are, which is the one thing it cannot be wrong about.
   */
  const [pendingHref, setPendingHref] = React.useState<string | null>(null);
  // The query counts too: the dashboard cards change only the tab.
  const here = `${pathname}?${useSearchParams().toString()}`;
  React.useEffect(() => setPendingHref(null), [here]);

  /*
   * Any link inside the admin, not only the tabs — a dashboard card,
   * "Open in Bookings" — starts the same busy state. Listened for in the capture
   * phase because Next's <Link> cancels the click's default before it bubbles.
   *
   * There is no loading skeleton any more. React holds a skeleton on screen for
   * at least 300ms once it is up, so it made every tab at least that slow even
   * when the page was ready in a third of the time; the bar and the dim below
   * answer the tap just as instantly without the wait.
   */
  React.useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = (event.target as Element | null)?.closest?.("a");
      if (!link || link.target === "_blank" || link.hasAttribute("download")) return;
      const next = new URL(link.href, window.location.href);
      if (next.origin !== window.location.origin || !next.pathname.startsWith("/admin")) return;
      if (next.pathname + next.search === window.location.pathname + window.location.search) return;
      setPendingHref(next.pathname + next.search);
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);

  // A navigation that never arrives — cancelled by the next tap, or a request that
  // failed — must not leave a tab spinning for the rest of the session.
  React.useEffect(() => {
    if (!pendingHref) return;
    const timer = window.setTimeout(() => setPendingHref(null), 8000);
    return () => window.clearTimeout(timer);
  }, [pendingHref]);

  return (
    // Opaque, not `bg-ink-50/60`: the document body is dark for the customer site,
    // so a translucent light surface composites over near-black and turns muddy.
    <div className="theme-light min-h-dvh bg-ink-50 text-ink-900 lg:flex">
      {/* Pinned to the viewport, not to the document: the locations form runs to
          several screens, and a sidebar that scrolls away with it leaves the
          owner with no way back except scrolling all the way up again. */}
      <aside className="hidden w-60 shrink-0 border-r border-ink-200 bg-white lg:sticky lg:top-0 lg:flex lg:h-dvh lg:flex-col">
        <div className="flex h-16 items-center gap-2 border-b border-ink-100 px-5">
          <PitchMark />
          <span className="text-lg font-bold tracking-tight text-ink-900">Turf Admin</span>
        </div>
        <nav className="flex-1 space-y-1 overflow-y-auto p-3" aria-label="Admin sections">
          {NAV.map((item) => {
            const on = isActive(item.href);
            const loading = pendingHref === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={on ? "page" : undefined}
                aria-busy={loading || undefined}
                className={cn(
                  "flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                  on ? "bg-pitch-600 font-semibold text-white shadow-sm" : "text-ink-600 hover:bg-ink-50",
                  loading && !on && "bg-ink-100 text-ink-800",
                )}
              >
                <item.icon className={cn("h-4 w-4", loading && "animate-pulse")} aria-hidden="true" />
                {item.label}
                {loading ? <Spinner className="ml-auto text-current" /> : null}
              </Link>
            );
          })}
        </nav>
        <div className="border-t border-ink-100 p-3">
          <p className="px-3 text-xs text-ink-500">
            Signed in as <span className="font-medium text-ink-700">{session.displayName}</span>
          </p>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-16 items-center justify-between gap-3 border-b border-ink-200 bg-white px-4 sm:px-6">
          {/* The sidebar already carries the name on a wide screen. */}
          <Link href="/admin" className="flex items-center gap-2.5 lg:hidden">
            <PitchMark />
            <span className="text-lg font-bold tracking-tight text-ink-900">Turf Admin</span>
          </Link>
          <div className="ml-auto flex items-center gap-2 sm:gap-3">
            <span className="hidden text-sm text-ink-500 sm:inline">
              Signed in as <span className="font-medium text-ink-700">{session.displayName}</span>
            </span>
            <Button variant="danger" size="sm" className="h-11 sm:h-9" onClick={signOut} disabled={signingOut}>
              <LogOut className="h-4 w-4" aria-hidden="true" />
              {signingOut ? "Signing out…" : "Sign out"}
            </Button>
          </div>
        </header>

        {/* Up the moment a link is tapped, gone when the new page is in. */}
        {pendingHref ? (
          <div
            role="progressbar"
            aria-label="Loading page"
            className="fixed inset-x-0 top-0 z-50 h-1 overflow-hidden bg-pitch-100"
          >
            <div className="h-full w-1/3 animate-admin-progress rounded-full bg-pitch-600" />
          </div>
        ) : null}

        {/* The extra bottom padding clears the tab bar *and* the iOS home indicator under it. */}
        <main
          id="main"
          aria-busy={pendingHref ? true : undefined}
          className={cn(
            "flex-1 px-4 py-5 pb-[calc(6rem+env(safe-area-inset-bottom))] transition-opacity sm:px-6 lg:pb-8",
            // Dimmed only if the wait outlasts a blink, so a fast page does not flicker.
            pendingHref ? "opacity-50 delay-150 duration-200" : "opacity-100 delay-0 duration-0",
          )}
        >
          {children}
        </main>

        {/* `admin-tabbar` steps aside while the keyboard is up — see globals.css. */}
        <nav
          className="admin-tabbar fixed inset-x-0 bottom-0 z-20 grid grid-cols-5 border-t border-ink-200 bg-white pb-[env(safe-area-inset-bottom)] lg:hidden"
          // Named apart from the sidebar: two landmarks called the same thing give
          // a screen reader user two identical entries and no way to tell them apart.
          aria-label="Admin sections, bottom bar"
        >
          {NAV.map((item) => {
            const on = isActive(item.href);
            const loading = pendingHref === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={on ? "page" : undefined}
                aria-busy={loading || undefined}
                className={cn(
                  "relative flex flex-col items-center gap-1 px-1 pb-2 pt-2.5 text-xs transition-colors",
                  on ? "font-semibold text-pitch-700" : "font-medium text-ink-500",
                  loading && !on && "text-ink-800",
                )}
              >
                {/* A pale tint is invisible at arm's length on a phone, so the active
                    tab is a solid filled pill with a bar above it. */}
                <span
                  aria-hidden="true"
                  className={cn(
                    "absolute inset-x-2 top-0 h-1 rounded-b-full transition-colors",
                    on ? "bg-pitch-600" : "bg-transparent",
                  )}
                />
                <span
                  className={cn(
                    "grid h-8 w-14 place-items-center rounded-full transition-colors",
                    on ? "bg-pitch-600 text-white shadow-sm" : "bg-transparent text-ink-500",
                    loading && !on && "bg-ink-100 text-ink-800",
                  )}
                >
                  {/* The tapped tab pulses until its page arrives. The filled pill
                      stays where the owner actually is, so a tap that never lands
                      cannot leave the wrong tab looking selected. */}
                  <item.icon className={cn("h-5 w-5", loading && "animate-pulse")} aria-hidden="true" />
                </span>
                <span>{item.short}</span>
              </Link>
            );
          })}
        </nav>
      </div>
    </div>
  );
}
