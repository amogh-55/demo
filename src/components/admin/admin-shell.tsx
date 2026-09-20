"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { CalendarRange, ClipboardList, LayoutDashboard, LogOut, MapPin, Settings } from "lucide-react";
import { api } from "@/lib/client";
import { Button, cn } from "@/components/ui/primitives";

/** Mirrors the server session shape; kept local so this client file never imports server code. */
interface AdminSessionView {
  username: string;
  displayName: string;
}

/** `short` exists because a five-column tab bar on a 360px phone cannot fit "Availability". */
const NAV = [
  { href: "/admin", label: "Dashboard", short: "Home", icon: LayoutDashboard },
  { href: "/admin/bookings", label: "Bookings", short: "Bookings", icon: ClipboardList },
  { href: "/admin/availability", label: "Availability", short: "Slots", icon: CalendarRange },
  { href: "/admin/locations", label: "Locations", short: "Grounds", icon: MapPin },
  { href: "/admin/settings", label: "Settings", short: "Settings", icon: Settings },
];

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
   * real round-trip behind it. Moving the highlight on tap rather than on arrival
   * means the tab bar answers immediately and the wait is visible where it is
   * actually happening.
   */
  const [tapped, setTapped] = React.useState<string | null>(null);
  React.useEffect(() => setTapped(null), [pathname]);
  const highlighted = (href: string) => (tapped ? tapped === href : isActive(href));

  return (
    // Opaque, not `bg-ink-50/60`: the document body is dark for the customer site,
    // so a translucent light surface composites over near-black and turns muddy.
    <div className="theme-light min-h-dvh bg-ink-50 text-ink-900 lg:flex">
      <aside className="hidden w-60 shrink-0 border-r border-ink-200 bg-white lg:flex lg:flex-col">
        <div className="flex h-16 items-center gap-2 border-b border-ink-100 px-5">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-pitch-600 text-sm text-white">🏏</span>
          <span className="font-semibold text-ink-900">Turf Admin</span>
        </div>
        <nav className="flex-1 space-y-1 p-3" aria-label="Admin sections">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              onClick={() => setTapped(item.href)}
              aria-current={isActive(item.href) ? "page" : undefined}
              className={cn(
                "flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                highlighted(item.href)
                  ? "bg-pitch-600 font-semibold text-white shadow-sm"
                  : "text-ink-600 hover:bg-ink-50",
              )}
            >
              <item.icon className="h-4 w-4" aria-hidden="true" />
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="border-t border-ink-100 p-3">
          <p className="px-3 pb-2 text-xs text-ink-500">
            Signed in as <span className="font-medium text-ink-700">{session.displayName}</span>
          </p>
          <Button variant="ghost" size="sm" className="w-full justify-start" onClick={signOut} disabled={signingOut}>
            <LogOut className="h-4 w-4" aria-hidden="true" />
            {signingOut ? "Signing out…" : "Sign out"}
          </Button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center justify-between border-b border-ink-200 bg-white px-4 lg:hidden">
          <span className="font-semibold text-ink-900">Turf Admin</span>
          <Button variant="ghost" size="sm" className="h-11" onClick={signOut} disabled={signingOut}>
            <LogOut className="h-4 w-4" aria-hidden="true" />
            Sign out
          </Button>
        </header>

        {/* The extra bottom padding clears the tab bar *and* the iOS home indicator under it. */}
        <main
          id="main"
          className="flex-1 px-4 py-5 pb-[calc(6rem+env(safe-area-inset-bottom))] sm:px-6 lg:pb-8"
        >
          {children}
        </main>

        <nav
          className="fixed inset-x-0 bottom-0 z-20 grid grid-cols-5 border-t border-ink-200 bg-white pb-[env(safe-area-inset-bottom)] lg:hidden"
          aria-label="Admin sections"
        >
          {NAV.map((item) => {
            const on = highlighted(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setTapped(item.href)}
                aria-current={isActive(item.href) ? "page" : undefined}
                className={cn(
                  "relative flex flex-col items-center gap-1 px-1 pb-2 pt-2.5 text-xs transition-colors",
                  on ? "font-semibold text-pitch-700" : "font-medium text-ink-500",
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
                  )}
                >
                  <item.icon className="h-5 w-5" aria-hidden="true" />
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
