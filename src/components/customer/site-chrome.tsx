"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowUp, Menu, Phone, X } from "lucide-react";
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
  /**
   * The hero has its own Book button a few centimetres below this one, and two
   * of them stacked reads as a mistake. So the header's CTA only appears once
   * the hero has scrolled away and the page no longer offers one.
   */
  const [pastHero, setPastHero] = React.useState(false);

  React.useEffect(() => {
    const onScroll = () => {
      setScrolled(window.scrollY > 24);
      // Measured against the viewport rather than a fixed pixel count, so it
      // behaves the same on a phone as on a desktop — and on pages with no hero
      // at all the first scroll brings the button straight in.
      setPastHero(window.scrollY > window.innerHeight * 0.6);
    };
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
          {/* Kept in the layout while hidden, so the header does not jolt sideways
              the moment it appears. */}
          <Link href="/book" className={cn("transition-opacity duration-300", pastHero ? "opacity-100" : "pointer-events-none opacity-0")} aria-hidden={!pastHero} tabIndex={pastHero ? undefined : -1}>
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

/** Back to the top, once there is enough page behind you to want it. */
export function ScrollToTop() {
  const [visible, setVisible] = React.useState(false);

  React.useEffect(() => {
    const onScroll = () => setVisible(window.scrollY > 600);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <button
      type="button"
      aria-label="Back to top"
      onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
      className={cn(
        "fixed bottom-6 right-5 z-40 grid h-12 w-12 place-items-center rounded-full bg-lime-400 text-ink-950 shadow-lg transition-all duration-300 hover:bg-lime-300",
        visible ? "translate-y-0 opacity-100" : "pointer-events-none translate-y-3 opacity-0",
      )}
    >
      <ArrowUp className="h-5 w-5" aria-hidden="true" />
    </button>
  );
}
