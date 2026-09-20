"use client";

import * as React from "react";
import Link from "next/link";
import { Menu, Phone, X } from "lucide-react";
import { Button, cn } from "@/components/ui/primitives";

const LINKS = [
  { href: "/#grounds", label: "Grounds" },
  { href: "/#facilities", label: "Facilities" },
  { href: "/#gallery", label: "Gallery" },
  { href: "/#location", label: "Location" },
  { href: "/#faq", label: "FAQ" },
];

/** Sticky header that goes solid once the hero scrolls away. */
export function SiteHeader({ businessName, supportPhone }: { businessName: string; supportPhone: string }) {
  const [scrolled, setScrolled] = React.useState(false);
  const [open, setOpen] = React.useState(false);

  React.useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 24);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header
      className={cn(
        "sticky top-0 z-40 transition-colors duration-300",
        scrolled || open ? "border-b border-white/10 bg-ink-950/90 backdrop-blur" : "bg-transparent",
      )}
    >
      <div className="container flex h-16 items-center justify-between gap-3">
        {/* A long business name must give way to the actions, not push them off screen. */}
        <Link href="/" className="flex min-w-0 items-center gap-2.5">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-lime-400 text-base">🏏</span>
          <span className="truncate text-sm font-extrabold uppercase tracking-tight text-white sm:text-base">
            {businessName}
          </span>
        </Link>

        <nav className="hidden items-center gap-1 lg:flex" aria-label="Sections">
          {LINKS.map((l) => (
            <a
              key={l.href}
              href={l.href}
              className="rounded-lg px-3 py-2 text-sm font-medium text-ink-300 transition-colors hover:bg-white/5 hover:text-white"
            >
              {l.label}
            </a>
          ))}
        </nav>

        <div className="flex shrink-0 items-center gap-2">
          {supportPhone ? (
            <a
              href={`tel:+91${supportPhone}`}
              className="hidden items-center gap-1.5 text-sm font-medium text-ink-300 hover:text-lime-300 sm:flex"
            >
              <Phone className="h-4 w-4" aria-hidden="true" />
              +91 {supportPhone}
            </a>
          ) : null}
          <Link href="/book">
            <Button>Book now</Button>
          </Link>
          <button
            type="button"
            aria-label={open ? "Close menu" : "Open menu"}
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
            className="grid h-11 w-11 place-items-center rounded-lg text-ink-200 hover:bg-white/10 lg:hidden"
          >
            {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        </div>
      </div>

      {open ? (
        <nav className="border-t border-white/10 lg:hidden" aria-label="Sections">
          <div className="container grid gap-1 py-3">
            {LINKS.map((l) => (
              <a
                key={l.href}
                href={l.href}
                onClick={() => setOpen(false)}
                className="rounded-lg px-3 py-3 text-sm font-medium text-ink-200 hover:bg-white/5"
              >
                {l.label}
              </a>
            ))}
          </div>
        </nav>
      ) : null}
    </header>
  );
}

/** Thumb-reachable booking CTA that appears after the hero on small screens. */
export function StickyBookBar() {
  const [visible, setVisible] = React.useState(false);

  React.useEffect(() => {
    const onScroll = () => setVisible(window.scrollY > 600);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  if (!visible) return null;

  return (
    // 72px tall plus the home-indicator inset. The assistant's floating button in
    // turf-assistant.tsx is offset to clear exactly that, so keep the two in step.
    <div className="fixed inset-x-0 bottom-0 z-30 border-t border-white/10 bg-ink-950/95 px-3 pb-[calc(0.75rem_+_env(safe-area-inset-bottom))] pt-3 backdrop-blur lg:hidden">
      <Link href="/book" className="block">
        <Button size="lg" className="w-full">
          Check availability
        </Button>
      </Link>
    </div>
  );
}
