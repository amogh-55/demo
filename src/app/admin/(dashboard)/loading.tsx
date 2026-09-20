/**
 * Shown the instant a tab is tapped, while the real page is queried.
 *
 * Every admin page is server-rendered from MongoDB, so there is a genuine
 * round-trip on each navigation. Without this the browser sits on the previous
 * screen for that whole time and the tab bar feels broken; with it the switch is
 * immediate and the wait is visibly the data loading, not the app hanging.
 */
export default function AdminSectionLoading() {
  return (
    <div className="mx-auto max-w-5xl animate-pulse space-y-4" aria-hidden="true">
      <div className="space-y-2">
        <div className="h-6 w-40 rounded bg-ink-200" />
        <div className="h-4 w-64 rounded bg-ink-100" />
      </div>

      <div className="rounded-xl border border-ink-200 bg-white p-4 sm:p-5">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="space-y-2">
              <div className="h-3 w-16 rounded bg-ink-100" />
              <div className="h-11 rounded-lg bg-ink-100" />
            </div>
          ))}
        </div>
      </div>

      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="rounded-xl border border-ink-200 bg-white p-4 sm:p-5">
          <div className="h-5 w-36 rounded bg-ink-200" />
          <div className="mt-2 h-4 w-52 rounded bg-ink-100" />
          <div className="mt-4 h-4 w-full max-w-md rounded bg-ink-100" />
          <div className="mt-2 h-5 w-24 rounded bg-ink-100" />
          <div className="mt-4 flex gap-2">
            <div className="h-11 w-32 rounded-lg bg-ink-100" />
            <div className="h-11 w-28 rounded-lg bg-ink-100" />
          </div>
        </div>
      ))}

      <span className="sr-only">Loading…</span>
    </div>
  );
}
