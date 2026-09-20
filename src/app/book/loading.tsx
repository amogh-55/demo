/**
 * Shown the instant a customer taps through to booking.
 *
 * The page itself is dynamic — it reads the catalogue and the settings on every
 * request — so without this the browser sits on the previous screen with only
 * its own tab spinner for company, which on a phone reads as a button that did
 * nothing. This puts the page's own shape on screen immediately instead.
 */
export default function BookLoading() {
  return (
    <div className="min-h-dvh bg-ink-950">
      <header className="border-b border-white/10">
        <div className="container flex h-16 items-center">
          <div className="h-4 w-16 animate-pulse rounded bg-white/10" />
        </div>
      </header>

      <div className="container py-8">
        <div className="h-8 w-56 animate-pulse rounded bg-white/10" />
        <div className="mt-3 h-4 w-72 animate-pulse rounded bg-white/5" />

        <div className="mt-8 space-y-4">
          {[0, 1, 2].map((card) => (
            <div key={card} className="rounded-xl border border-white/10 bg-white/[0.03] p-5">
              <div className="h-4 w-40 animate-pulse rounded bg-white/10" />
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                {[0, 1, 2, 3].map((row) => (
                  <div key={row} className="h-16 animate-pulse rounded-lg bg-white/5" />
                ))}
              </div>
            </div>
          ))}
        </div>

        <p className="mt-6 text-center text-sm text-ink-400">Loading live availability…</p>
      </div>
    </div>
  );
}
