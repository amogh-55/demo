import Link from "next/link";
import { ArrowLeft } from "lucide-react";

/** The owner's number for anything about these policies, as they gave it. */
export const POLICY_PHONE = "9346196161";
export const POLICY_PHONE_DISPLAY = "+91 93461 96161";

/** Linked from the home page footer, which is where Razorpay's review looks for them. */
export const LEGAL_LINKS = [
  { href: "/terms", label: "Terms" },
  { href: "/privacy", label: "Privacy" },
  { href: "/refund-policy", label: "Refunds" },
  { href: "/contact", label: "Contact" },
] as const;

export const LEGAL_UPDATED = "4 October 2026";

/** The frame every policy page shares: a way back, a title, and the other policies. */
export function LegalPage({
  businessName,
  title,
  children,
}: {
  businessName: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-dvh bg-ink-950">
      <header className="border-b border-white/10 bg-ink-950/90 backdrop-blur">
        <div className="container flex h-16 items-center justify-between gap-3">
          <Link
            href="/"
            className="-ml-2 flex min-h-[44px] shrink-0 items-center gap-2 px-2 text-sm font-medium text-ink-300 hover:text-lime-400"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            Home
          </Link>
          <p className="truncate text-sm font-extrabold uppercase tracking-tight text-white">{businessName}</p>
        </div>
      </header>

      <main id="main" className="container max-w-3xl py-8 sm:py-12">
        <h1 className="text-2xl font-extrabold tracking-tight text-white sm:text-3xl">{title}</h1>
        <p className="mt-2 text-xs text-ink-500">Last updated {LEGAL_UPDATED}</p>
        <div className="mt-8 space-y-8 text-sm leading-relaxed text-ink-300">{children}</div>
      </main>

      <footer className="border-t border-white/10 py-8">
        <nav className="container flex flex-wrap gap-x-5 gap-y-2 text-sm text-ink-500" aria-label="Policies">
          {LEGAL_LINKS.map((l) => (
            <Link key={l.href} href={l.href} className="py-1 hover:text-ink-300">
              {l.label}
            </Link>
          ))}
        </nav>
      </footer>
    </div>
  );
}

export function LegalSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="text-base font-semibold text-white">{title}</h2>
      <div className="mt-2 space-y-2">{children}</div>
    </section>
  );
}

export function LegalList({ children }: { children: React.ReactNode }) {
  return <ul className="list-disc space-y-1.5 pl-5">{children}</ul>;
}

/** "Call us" in every policy, so nobody has to go hunting for the number. */
export function CallUs() {
  return (
    <a href={`tel:+91${POLICY_PHONE}`} className="font-medium text-lime-400 hover:text-lime-300">
      {POLICY_PHONE_DISPLAY}
    </a>
  );
}
