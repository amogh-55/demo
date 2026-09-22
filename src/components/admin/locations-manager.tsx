"use client";

import * as React from "react";
import { Plus, Trash2 } from "lucide-react";
import { api, errorMessage } from "@/lib/client";
import { formatMinutes, minutesToDuration } from "@/lib/time";
import { Alert, Button, FieldError, Spinner, cn, formatCurrency } from "@/components/ui/primitives";

interface AdminLocation {
  id: string;
  name: string;
  slug: string;
  address: string;
  mapsUrl: string;
  description: string;
  image: string;
  phone: string;
  active: boolean;
}

interface PriceRule {
  fromMin: number;
  toMin: number;
  price: number;
}

interface BallType {
  id: string;
  name: string;
  /** What one block of overs costs — "₹180 for 10 overs". */
  pricePerSlot: number;
}

interface FacilityConfig {
  slotMinutes: number;
  openMin: number;
  closeMin: number;
  priceRules: PriceRule[];
  /** Empty for a ground that charges the same every day, which is the usual case. */
  weekendPriceRules?: PriceRule[];
  /** Which days the weekend table covers: 0 Sunday … 6 Saturday. */
  weekendDays?: number[];
  bookingWindowDays: number;
  holdMinutes: number;
  oversPerSlot: number;
  payAtVenueMaxOvers: number;
  advancePercent?: number;
  ballTypes: BallType[];
}

interface AdminFacility {
  id: string;
  locationId: string;
  name: string;
  slug: string;
  kind: "HOURLY" | "OVERS";
  description: string;
  sortOrder: number;
  active: boolean;
  config: FacilityConfig;
}

interface AdminResource {
  id: string;
  locationId: string;
  facilityId: string;
  name: string;
  slug: string;
  sortOrder: number;
  active: boolean;
}

interface Tree {
  facilities: AdminFacility[];
  resources: AdminResource[];
}

const HOURS = Array.from({ length: 25 }, (_, i) => i * 60);

/**
 * A price the owner has not typed yet.
 *
 * `NaN` rather than a separate draft type: it lives in the same `number` field
 * every price already uses, renders as an empty box, and `Number.isFinite` is
 * the one check for "is this set". A blank field used to snap straight back to
 * 0 — `Number("")` is 0 — so deleting "700" left a stubborn zero that the next
 * keystroke turned into "0900".
 */
const UNSET = Number.NaN;
const isSet = (price: number) => Number.isFinite(price);

/**
 * A price box that can be emptied.
 *
 * It keeps the text the owner typed, not a number round-tripped through the
 * state: the round trip is what made the zero impossible to delete, and what
 * turned a half-typed "0.5" into "0". Only a value that parses is pushed up.
 */
function PriceInput({
  id,
  value,
  onChange,
  invalid,
  describedBy,
  min = 0,
  max,
}: {
  id: string;
  value: number;
  onChange: (next: number) => void;
  invalid?: boolean;
  describedBy?: string;
  min?: number;
  max?: number;
}) {
  const [raw, setRaw] = React.useState(() => (isSet(value) ? String(value) : ""));

  // Follows the value when something other than typing changes it — switching
  // facility, or a band the editor added — without fighting the box mid-keystroke.
  React.useEffect(() => {
    setRaw((current) => (Number(current) === value && current !== "" ? current : isSet(value) ? String(value) : ""));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return (
    <input
      id={id}
      type="number"
      inputMode="numeric"
      min={min}
      max={max}
      className="field-input"
      aria-invalid={invalid ? true : undefined}
      aria-describedby={describedBy}
      value={raw}
      onChange={(e) => {
        const next = e.target.value;
        setRaw(next);
        onChange(next.trim() === "" ? UNSET : Number(next));
      }}
    />
  );
}

type Problems = Record<string, string>;

/** Every slot start the operating window produces. */
function slotStarts(openMin: number, closeMin: number, slotMinutes: number): number[] {
  const starts: number[] = [];
  if (!(slotMinutes > 0) || !(closeMin > openMin)) return starts;
  for (let m = openMin; m + slotMinutes <= closeMin; m += slotMinutes) starts.push(m);
  return starts;
}

/**
 * The runs of time inside the operating window that no band prices.
 *
 * Unpriced time does not error anywhere — it simply vanishes from the customer's
 * grid, which is how a ground can be "open from midnight" and still show nothing
 * before 6 AM. Returned as bands so the editor can offer to add them.
 */
function gapBands(rules: PriceRule[], openMin: number, closeMin: number, slotMinutes: number): PriceRule[] {
  const gaps: PriceRule[] = [];
  let run: { from: number; to: number } | null = null;

  for (const start of slotStarts(openMin, closeMin, slotMinutes)) {
    const priced = rules.some((r) => start >= r.fromMin && start < r.toMin);
    if (priced) {
      if (run) gaps.push({ fromMin: run.from, toMin: run.to, price: UNSET });
      run = null;
      continue;
    }
    run = run ? { from: run.from, to: start + slotMinutes } : { from: start, to: start + slotMinutes };
  }
  if (run) gaps.push({ fromMin: run.from, toMin: run.to, price: UNSET });
  return gaps;
}

/**
 * Everything wrong with a schedule, keyed by the field it belongs to.
 *
 * Run on every keystroke rather than on save. The complaint the owner used to
 * get — "closing time cannot be before opening time" — arrived after they had
 * scrolled to the bottom and pressed Save, by which point it was no longer
 * obvious which of the boxes above it was about.
 */
function scheduleProblems(config: FacilityConfig, kind: "HOURLY" | "OVERS"): Problems {
  const p: Problems = {};

  if (!(config.closeMin > config.openMin)) {
    p.closeMin = "Closing time must be after opening time.";
  } else if ((config.closeMin - config.openMin) % config.slotMinutes !== 0) {
    p.closeMin = `Opening hours must divide into whole ${config.slotMinutes}-minute slots.`;
  }

  const advance = config.advancePercent ?? 0;
  if (!Number.isInteger(advance) || advance < 0 || advance > 99) {
    p.advancePercent = "Enter a percentage between 0 and 99. Use 0 to take the full amount up front.";
  }
  if (!Number.isInteger(config.bookingWindowDays) || config.bookingWindowDays < 0 || config.bookingWindowDays > 365) {
    p.bookingWindowDays = "Enter a number of days between 0 and 365.";
  }

  const checkBands = (rules: PriceRule[], prefix: string, label: string) => {
    // The hours are named rather than called "these hours", because the summary
    // at the foot of the form lists every problem together, and three identical
    // lines saying "Set a price for these hours" tell the owner nothing about
    // which three bands are empty.
    const which = prefix === "weekend" ? "weekend price" : "price";
    rules.forEach((rule, i) => {
      const when = `${formatMinutes(rule.fromMin)}–${formatMinutes(rule.toMin)}`;
      if (rule.toMin <= rule.fromMin) p[`${prefix}-range-${i}`] = "The end of a band must be after its start.";
      if (!isSet(rule.price)) p[`${prefix}-price-${i}`] = `Set a ${which} for ${when}.`;
      else if (rule.price < 0) p[`${prefix}-price-${i}`] = "A price cannot be negative.";
    });

    const gaps = gapBands(rules, config.openMin, config.closeMin, config.slotMinutes);
    if (gaps.length > 0) {
      p[`${prefix}-coverage`] =
        `${label} ${gaps.map((g) => `${formatMinutes(g.fromMin)}–${formatMinutes(g.toMin)}`).join(", ")} ` +
        "has no price, so customers cannot book it. Add a band covering it.";
    }
  };

  if (kind === "HOURLY") {
    if (config.priceRules.length === 0) p["weekday-coverage"] = "Add at least one price band.";
    else checkBands(config.priceRules, "weekday", "");

    const weekend = config.weekendPriceRules ?? [];
    if (weekend.length > 0) {
      checkBands(weekend, "weekend", "");
      if ((config.weekendDays ?? []).length === 0) {
        p.weekendDays = "Pick at least one day, or turn weekend pricing off.";
      }
    }
  } else {
    if (!Number.isInteger(config.oversPerSlot) || config.oversPerSlot < 1) {
      p.oversPerSlot = "Enter how many overs one block buys.";
    } else if (config.payAtVenueMaxOvers > 0 && config.payAtVenueMaxOvers % config.oversPerSlot !== 0) {
      p.payAtVenueMaxOvers = `Must be a whole number of ${config.oversPerSlot}-over blocks.`;
    }
    if (config.ballTypes.length === 0) p.ballTypes = "Add at least one ball type.";
    config.ballTypes.forEach((ball, i) => {
      if (!ball.name.trim()) p[`ball-name-${i}`] = "Give this ball a name.";
      if (!isSet(ball.pricePerSlot)) p[`ball-price-${i}`] = "Set a price for this ball.";
      else if (ball.pricePerSlot < 0) p[`ball-price-${i}`] = "A price cannot be negative.";
    });
  }

  return p;
}


/** "Bowling Machine" → "bowling-machine", for the slug fields. */
function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

export function LocationsManager({
  initialLocations,
  initialTree,
}: {
  initialLocations: AdminLocation[];
  /** Rendered on the server with the locations, so no ground ever reads "0 facilities". */
  initialTree: Tree;
}) {
  const [locations, setLocations] = React.useState(initialLocations);
  const [selectedId, setSelectedId] = React.useState(initialLocations[0]?.id ?? "");
  const [tree, setTree] = React.useState<Tree>(initialTree);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const selected = locations.find((l) => l.id === selectedId);

  // Only after an edit. The first paint already has the tree the server sent, so
  // there is no fetch on mount and nothing to be briefly wrong about.
  const refreshTree = React.useCallback(async () => {
    try {
      const data = await api<Tree>("/api/admin/facilities");
      setTree({ facilities: data.facilities, resources: data.resources });
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  async function refreshLocations() {
    const data = await api<{ locations: AdminLocation[] }>("/api/admin/locations");
    setLocations(data.locations);
  }

  async function toggleActive(location: AdminLocation) {
    setError(null);
    try {
      await api(`/api/admin/locations/${location.id}`, {
        method: "PATCH",
        body: JSON.stringify({ active: !location.active }),
      });
      setNotice(
        location.active
          ? `${location.name} is now hidden from customers. Existing bookings are unaffected.`
          : `${location.name} is accepting bookings again.`,
      );
      await refreshLocations();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <div className="space-y-4">
      {notice ? (
        <Alert tone="success" className="flex items-center justify-between gap-3">
          <span className="min-w-0 break-words">{notice}</span>
          <button type="button" className="h-11 shrink-0 px-2 text-xs underline" onClick={() => setNotice(null)}>
            Dismiss
          </button>
        </Alert>
      ) : null}
      {error ? <Alert tone="error">{error}</Alert> : null}

      <section className="card">
        <h2 className="font-semibold text-ink-900">Locations</h2>
        <ul className="mt-3 divide-y divide-ink-100">
          {locations.map((l) => {
            const count = tree.facilities.filter((f) => f.locationId === l.id).length;
            return (
              <li key={l.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <button type="button" className="min-w-0 flex-1 py-1 text-left" onClick={() => setSelectedId(l.id)}>
                  <span className={cn("block truncate font-medium", selectedId === l.id ? "text-pitch-700" : "text-ink-900")}>
                    {l.name}
                  </span>
                  <span className="mt-0.5 block truncate text-sm text-ink-500">
                    {count} facilit{count === 1 ? "y" : "ies"} · {l.address}
                  </span>
                </button>
                <div className="flex w-full items-center justify-between gap-2 sm:w-auto">
                  <span
                    className={cn(
                      "rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ring-inset",
                      l.active ? "bg-green-50 text-green-800 ring-green-600/30" : "bg-ink-100 text-ink-600 ring-ink-300",
                    )}
                  >
                    {l.active ? "Active" : "Hidden"}
                  </span>
                  <Button size="sm" variant="secondary" className="h-11 sm:h-9" onClick={() => void toggleActive(l)}>
                    {l.active ? "Deactivate" : "Activate"}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      {locations.length > 1 ? (
        <section className="card">
          <label className="field-label" htmlFor="editing-location">
            Editing
          </label>
          {/* The list above is selectable too, but a name that turns green when
              tapped does not read as a control — people assumed the editor below
              was stuck on whichever ground happened to be first. */}
          <select
            id="editing-location"
            className="field-input"
            value={selectedId}
            onChange={(e) => setSelectedId(e.target.value)}
          >
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
          <p className="mt-1.5 text-xs text-ink-500">
            Details, facilities and pricing below apply to this ground only.
          </p>
        </section>
      ) : null}

      {/* Both are keyed on the ground so switching grounds remounts them with fresh
          state — but they are siblings, so the keys have to differ from each other. */}
      {selected ? <LocationEditor key={`editor-${selected.id}`} location={selected} onSaved={refreshLocations} /> : null}
      {selected ? (
        <FacilitiesManager
          key={`facilities-${selected.id}`}
          location={selected}
          facilities={tree.facilities.filter((f) => f.locationId === selected.id)}
          resources={tree.resources}
          onChanged={refreshTree}
        />
      ) : null}
    </div>
  );
}

function LocationEditor({ location, onSaved }: { location: AdminLocation; onSaved: () => Promise<void> }) {
  const [form, setForm] = React.useState(location);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [saved, setSaved] = React.useState(false);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/admin/locations/${location.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: form.name,
          address: form.address,
          mapsUrl: form.mapsUrl,
          description: form.description,
          image: form.image,
          phone: form.phone,
        }),
      });
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2000);
      await onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h2 className="break-words font-semibold text-ink-900">Edit {location.name}</h2>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <Text label="Name" value={form.name} onChange={(name) => setForm({ ...form, name })} />
        <Text label="Phone" value={form.phone} onChange={(phone) => setForm({ ...form, phone })} />
        <div className="sm:col-span-2">
          <Text label="Address" value={form.address} onChange={(address) => setForm({ ...form, address })} />
        </div>
        <div className="sm:col-span-2">
          <Text
            label="Google Maps link"
            value={form.mapsUrl}
            onChange={(mapsUrl) => setForm({ ...form, mapsUrl })}
            hint="Open the ground in Google Maps, tap Share and paste the link. Leave blank to search by name."
          />
        </div>
        <div className="sm:col-span-2">
          <Text label="Description" value={form.description} onChange={(description) => setForm({ ...form, description })} />
        </div>
        <div className="sm:col-span-2">
          <Text label="Image path" value={form.image} onChange={(image) => setForm({ ...form, image })} />
        </div>
      </div>
      {error ? <Alert tone="error" className="mt-3">{error}</Alert> : null}
      <Button className="mt-4 w-full sm:w-auto" onClick={save} disabled={busy}>
        {busy ? <Spinner /> : null}
        {busy ? "Saving…" : saved ? "Saved" : "Save location"}
      </Button>
    </section>
  );
}

/**
 * What this ground sells, and what is bookable under each of those.
 *
 * The two levels are deliberately visible to the owner rather than hidden behind
 * one flat list: "Pickleball" is one thing they price and open, while "Court 1"
 * and "Court 2" are two things that can be booked at the same hour, and the
 * difference is exactly what they need to be able to see.
 */
function FacilitiesManager({
  location,
  facilities,
  resources,
  onChanged,
}: {
  location: AdminLocation;
  facilities: AdminFacility[];
  resources: AdminResource[];
  onChanged: () => Promise<void>;
}) {
  const [selectedId, setSelectedId] = React.useState(facilities[0]?.id ?? "");
  const [adding, setAdding] = React.useState(false);
  const [newName, setNewName] = React.useState("");
  const [newKind, setNewKind] = React.useState<"HOURLY" | "OVERS">("HOURLY");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (facilities.some((f) => f.id === selectedId)) return;
    setSelectedId(facilities[0]?.id ?? "");
  }, [facilities, selectedId]);

  const selected = facilities.find((f) => f.id === selectedId);

  async function addFacility() {
    if (busy || newName.trim().length < 2) return;
    setBusy(true);
    setError(null);
    try {
      await api("/api/admin/facilities", {
        method: "POST",
        body: JSON.stringify({
          locationId: location.id,
          name: newName.trim(),
          slug: slugify(newName),
          kind: newKind,
          sortOrder: facilities.length,
        }),
      });
      setNewName("");
      setAdding(false);
      await onChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function toggleFacility(facility: AdminFacility) {
    setError(null);
    try {
      await api(`/api/admin/facilities/${facility.id}`, {
        method: "PATCH",
        body: JSON.stringify({ active: !facility.active }),
      });
      await onChanged();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <>
      <section className="card">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="break-words font-semibold text-ink-900">Facilities at {location.name}</h2>
          <Button size="sm" variant="secondary" className="h-11 sm:h-9" onClick={() => setAdding((v) => !v)}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            Add facility
          </Button>
        </div>

        {facilities.length === 0 ? (
          <p className="mt-3 text-sm text-ink-500">
            Nothing here yet. Until a facility is added, this ground is hidden from customers.
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-ink-100">
            {facilities.map((f) => {
              const own = resources.filter((r) => r.facilityId === f.id);
              return (
                <li key={f.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <button type="button" className="min-w-0 flex-1 py-1 text-left" onClick={() => setSelectedId(f.id)}>
                    <span className={cn("block truncate font-medium", selectedId === f.id ? "text-pitch-700" : "text-ink-900")}>
                      {f.name}
                    </span>
                    <span className="mt-0.5 block truncate text-sm text-ink-500">
                      {f.kind === "OVERS" ? "By the over" : "By the hour"} · {own.length} bookable
                      {own.length === 1 ? "" : " courts"}
                    </span>
                  </button>
                  <div className="flex w-full items-center justify-between gap-2 sm:w-auto">
                    <span
                      className={cn(
                        "rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ring-inset",
                        f.active ? "bg-green-50 text-green-800 ring-green-600/30" : "bg-ink-100 text-ink-600 ring-ink-300",
                      )}
                    >
                      {f.active ? "Active" : "Hidden"}
                    </span>
                    <Button size="sm" variant="secondary" className="h-11 sm:h-9" onClick={() => void toggleFacility(f)}>
                      {f.active ? "Hide" : "Show"}
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {adding ? (
          <div className="mt-4 grid gap-3 rounded-lg border border-ink-200 p-3 sm:grid-cols-[1fr,auto,auto] sm:items-end">
            <Text label="Name" value={newName} onChange={setNewName} />
            <div>
              <label className="field-label" htmlFor="new-facility-kind">
                Sold as
              </label>
              <select
                id="new-facility-kind"
                className="field-input"
                value={newKind}
                onChange={(e) => setNewKind(e.target.value as "HOURLY" | "OVERS")}
              >
                <option value="HOURLY">By the hour</option>
                <option value="OVERS">By the over (bowling machine)</option>
              </select>
            </div>
            <Button className="h-11 sm:h-[42px]" onClick={addFacility} disabled={busy || newName.trim().length < 2}>
              {busy ? <Spinner /> : null}
              Create
            </Button>
          </div>
        ) : null}

        {error ? <Alert tone="error" className="mt-3">{error}</Alert> : null}
      </section>

      {facilities.length > 1 ? (
        <section className="card">
          <label className="field-label" htmlFor="editing-facility">
            Editing facility
          </label>
          <select
            id="editing-facility"
            className="field-input"
            value={selectedId}
            onChange={(e) => setSelectedId(e.target.value)}
          >
            {facilities.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </section>
      ) : null}

      {selected ? (
        <ResourcesEditor
          key={`${selected.id}-resources`}
          facility={selected}
          resources={resources.filter((r) => r.facilityId === selected.id)}
          onChanged={onChanged}
        />
      ) : null}
      {selected ? <ScheduleEditor key={`${selected.id}-schedule`} facility={selected} onSaved={onChanged} /> : null}
    </>
  );
}

/** The individually bookable things: court 1, court 2, net 3. */
function ResourcesEditor({
  facility,
  resources,
  onChanged,
}: {
  facility: AdminFacility;
  resources: AdminResource[];
  onChanged: () => Promise<void>;
}) {
  const [error, setError] = React.useState<string | null>(null);

  async function toggle(resource: AdminResource) {
    setError(null);
    try {
      await api(`/api/admin/resources/${resource.id}`, {
        method: "PATCH",
        body: JSON.stringify({ active: !resource.active }),
      });
      await onChanged();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <section className="card">
      <h2 className="break-words font-semibold text-ink-900">Bookable courts · {facility.name}</h2>
      <p className="mt-1 text-sm text-ink-600">
        Each one is booked and blocked on its own. Two courts here means two customers can play at the same hour.
        Hide one to take it off the customer&apos;s grid.
      </p>

      <ul className="mt-3 divide-y divide-ink-100">
        {resources.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
            <span className="min-w-0 flex-1 truncate font-medium text-ink-900">{r.name}</span>
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  "rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ring-inset",
                  r.active ? "bg-green-50 text-green-800 ring-green-600/30" : "bg-ink-100 text-ink-600 ring-ink-300",
                )}
              >
                {r.active ? "Active" : "Hidden"}
              </span>
              <Button size="sm" variant="secondary" className="h-11 sm:h-9" onClick={() => void toggle(r)}>
                {r.active ? "Hide" : "Show"}
              </Button>
            </div>
          </li>
        ))}
      </ul>

      {error ? <Alert tone="error" className="mt-3">{error}</Alert> : null}
    </section>
  );
}

function ScheduleEditor({ facility, onSaved }: { facility: AdminFacility; onSaved: () => Promise<void> }) {
  const [config, setConfig] = React.useState<FacilityConfig>(facility.config);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [saved, setSaved] = React.useState(false);

  const isOvers = facility.kind === "OVERS";
  const problems = scheduleProblems(config, facility.kind);
  const problemCount = Object.keys(problems).length;

  /**
   * Widening the hours without widening the price bands leaves the new time
   * unpriced, and unpriced time does not warn — it just never appears on the
   * customer's grid. Opening at midnight and finding nothing bookable before 6
   * looks exactly like a broken site.
   *
   * So the bands follow the hours in both directions: an empty band is laid
   * down over whatever the change exposed, the validation below refuses to save
   * until a price is typed into it, and narrowing the hours takes those empty
   * bands away again.
   */
  const update = (patch: Partial<FacilityConfig>) => {
    setConfig((current) => {
      const next = { ...current, ...patch };
      const hoursMoved = patch.openMin !== undefined || patch.closeMin !== undefined;
      if (!hoursMoved || facility.kind !== "HOURLY" || !(next.closeMin > next.openMin)) return next;

      const fill = (rules: PriceRule[]) => {
        if (rules.length === 0) return rules;
        /*
         * Narrowing the hours again has to take those placeholders back out.
         * Otherwise opening at midnight and changing your mind leaves an empty
         * 12 AM–6 AM band sitting outside the hours, demanding a price for time
         * the ground is now shut.
         *
         * Only the empty ones go. A band with a price in it is the owner's own
         * work, and hours get nudged by accident.
         */
        const kept = rules.filter(
          (rule) => isSet(rule.price) || (rule.toMin > next.openMin && rule.fromMin < next.closeMin),
        );
        return kept.length === 0 ? kept : [...kept, ...gapBands(kept, next.openMin, next.closeMin, next.slotMinutes)];
      };

      return {
        ...next,
        priceRules: fill(next.priceRules),
        weekendPriceRules: fill(next.weekendPriceRules ?? []),
      };
    });
  };

  async function save() {
    if (problemCount > 0) {
      setError("Fix the highlighted fields first.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api(`/api/admin/facilities/${facility.id}`, { method: "PUT", body: JSON.stringify(config) });
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2000);
      await onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h2 className="break-words font-semibold text-ink-900">Hours &amp; pricing · {facility.name}</h2>
      <p className="mt-1 text-sm text-ink-600">
        Existing bookings keep the price they were charged. Changes only affect new bookings.
      </p>

      <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <div>
          <label className="field-label" htmlFor="open-min">
            Opens at
          </label>
          <select id="open-min" className="field-input" value={config.openMin} onChange={(e) => update({ openMin: Number(e.target.value) })}>
            {HOURS.slice(0, 24).map((m) => (
              <option key={m} value={m}>
                {formatMinutes(m)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="field-label" htmlFor="close-min">
            Closes at
          </label>
          <select
            id="close-min"
            className="field-input"
            aria-invalid={problems.closeMin ? true : undefined}
            aria-describedby={problems.closeMin ? "close-min-error" : undefined}
            value={config.closeMin}
            onChange={(e) => update({ closeMin: Number(e.target.value) })}
          >
            {HOURS.slice(1).map((m) => (
              <option key={m} value={m}>
                {m === 1440 ? "12:00 AM (midnight)" : formatMinutes(m)}
              </option>
            ))}
          </select>
          {problems.closeMin ? <FieldError id="close-min-error">{problems.closeMin}</FieldError> : null}
        </div>
        {/* Slot length and hold duration are deliberately not editable here. Slot
            length is the unit the double-booking index is built on — the server
            refuses to change it under live bookings — and it is decided by how the
            facility is sold: an hour for play, a quarter-hour for a machine. */}
        <div>
          <label className="field-label" htmlFor="window-days">
            Booking window (days ahead)
          </label>
          <PriceInput
            id="window-days"
            min={0}
            max={365}
            value={config.bookingWindowDays}
            invalid={Boolean(problems.bookingWindowDays)}
            describedBy={problems.bookingWindowDays ? "window-days-error" : undefined}
            onChange={(bookingWindowDays) => update({ bookingWindowDays })}
          />
          {problems.bookingWindowDays ? (
            <FieldError id="window-days-error">{problems.bookingWindowDays}</FieldError>
          ) : null}
        </div>

        <div>
          <label className="field-label" htmlFor="advance-percent">
            Pay now to book (%)
          </label>
          <PriceInput
            id="advance-percent"
            min={0}
            max={99}
            value={config.advancePercent ?? 0}
            invalid={Boolean(problems.advancePercent)}
            describedBy={problems.advancePercent ? "advance-percent-error" : undefined}
            onChange={(advancePercent) => update({ advancePercent })}
          />
          {problems.advancePercent ? (
            <FieldError id="advance-percent-error">{problems.advancePercent}</FieldError>
          ) : null}
          <p className="mt-1.5 text-xs text-ink-500">
            Customers may pay this share online and the rest at the ground — set 50 for half now, half on arrival. Leave
            at 0 to take the full amount before confirming.
          </p>
        </div>
      </div>

      {isOvers ? (
        <OversPricing config={config} update={update} problems={problems} />
      ) : (
        <HourlyPricing config={config} update={update} problems={problems} />
      )}

      {/* Listed as well as outlined: on a phone the offending field is usually
          scrolled off screen by the time the owner reaches Save, and "fix the
          highlighted fields" is no help when none of them are visible. */}
      {problemCount > 0 ? (
        <Alert tone="error" className="mt-4">
          <p className="font-semibold">
            {problemCount === 1 ? "One thing needs fixing" : `${problemCount} things need fixing`} before this can be
            saved:
          </p>
          <ul className="mt-1.5 list-disc space-y-0.5 pl-4">
            {Object.entries(problems).map(([key, message]) => (
              <li key={key}>{message}</li>
            ))}
          </ul>
        </Alert>
      ) : null}

      {error ? <Alert tone="error" className="mt-3">{error}</Alert> : null}

      <Button className="mt-4 w-full sm:w-auto" onClick={save} disabled={busy || problemCount > 0}>
        {busy ? <Spinner /> : null}
        {busy ? "Saving…" : saved ? "Saved" : "Save schedule"}
      </Button>
    </section>
  );
}

/** 0 Sunday … 6 Saturday, in the order a week is spoken. */
const WEEK = [
  { day: 1, label: "Mon" },
  { day: 2, label: "Tue" },
  { day: 3, label: "Wed" },
  { day: 4, label: "Thu" },
  { day: 5, label: "Fri" },
  { day: 6, label: "Sat" },
  { day: 0, label: "Sun" },
];

/**
 * One table of price bands.
 *
 * Written once and rendered twice — weekdays and weekends — because they are the
 * same thing charged on different days, and two copies of this would be two
 * places for a rounding rule or a time format to drift apart.
 */
function PriceBands({
  idPrefix,
  problemKey,
  problems,
  title,
  description,
  rules,
  openMin,
  closeMin,
  slotMinutes,
  onChange,
  minBands = 1,
}: {
  idPrefix: string;
  /** Which half of {@link scheduleProblems} this table's complaints are under. */
  problemKey: "weekday" | "weekend";
  problems: Problems;
  title: string;
  description: string;
  rules: PriceRule[];
  openMin: number;
  closeMin: number;
  slotMinutes: number;
  onChange: (rules: PriceRule[]) => void;
  minBands?: number;
}) {
  const config = { priceRules: rules, openMin, closeMin };
  const update = (patch: { priceRules: PriceRule[] }) => onChange(patch.priceRules);
  return (
    <>
      <h3 className="mt-6 font-medium text-ink-900">{title}</h3>
      <p className="mt-1 text-sm text-ink-600">{description}</p>
      {/* Three selects and a delete button in one row need desktop width; on a phone the
          band wraps to two rows and gets a border so the bands stay distinguishable. */}
      <ul className="mt-3 space-y-3 sm:space-y-2">
        {config.priceRules.map((rule, index) => (
          <li
            key={index}
            className="grid grid-cols-2 items-end gap-2 rounded-lg border border-ink-200 p-3 sm:grid-cols-[1fr,1fr,1fr,auto] sm:border-0 sm:p-0"
          >
            <div>
              <label className="field-label text-xs" htmlFor={`${idPrefix}-from-${index}`}>
                From
              </label>
              <select
                id={`${idPrefix}-from-${index}`}
                className="field-input"
                value={rule.fromMin}
                onChange={(e) => {
                  const rules = [...config.priceRules];
                  rules[index] = { ...rule, fromMin: Number(e.target.value) };
                  update({ priceRules: rules });
                }}
              >
                {HOURS.slice(0, 24).map((m) => (
                  <option key={m} value={m}>
                    {formatMinutes(m)}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="field-label text-xs" htmlFor={`${idPrefix}-to-${index}`}>
                To
              </label>
              <select
                id={`${idPrefix}-to-${index}`}
                className="field-input"
                value={rule.toMin}
                onChange={(e) => {
                  const rules = [...config.priceRules];
                  rules[index] = { ...rule, toMin: Number(e.target.value) };
                  update({ priceRules: rules });
                }}
              >
                {HOURS.slice(1).map((m) => (
                  <option key={m} value={m}>
                    {m === 1440 ? "12:00 AM" : formatMinutes(m)}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="field-label text-xs" htmlFor={`${idPrefix}-price-${index}`}>
                Price per slot
              </label>
              <PriceInput
                id={`${idPrefix}-price-${index}`}
                value={rule.price}
                invalid={Boolean(problems[`${problemKey}-price-${index}`])}
                describedBy={
                  problems[`${problemKey}-price-${index}`] ? `${idPrefix}-price-${index}-error` : undefined
                }
                onChange={(price) => {
                  const rules = [...config.priceRules];
                  rules[index] = { ...rule, price };
                  update({ priceRules: rules });
                }}
              />
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="h-11 w-11 justify-self-end sm:h-9 sm:w-auto"
              aria-label={`Remove price band ${index + 1}`}
              onClick={() => update({ priceRules: config.priceRules.filter((_, i) => i !== index) })}
              disabled={config.priceRules.length <= minBands}
            >
              <Trash2 className="h-4 w-4" aria-hidden="true" />
            </Button>
            {problems[`${problemKey}-price-${index}`] || problems[`${problemKey}-range-${index}`] ? (
              <div className="col-span-2 sm:col-span-4">
                {problems[`${problemKey}-range-${index}`] ? (
                  <FieldError>{problems[`${problemKey}-range-${index}`]}</FieldError>
                ) : null}
                {problems[`${problemKey}-price-${index}`] ? (
                  <FieldError id={`${idPrefix}-price-${index}-error`}>
                    {problems[`${problemKey}-price-${index}`]}
                  </FieldError>
                ) : null}
              </div>
            ) : null}
          </li>
        ))}
      </ul>

      {/* Hours nobody priced. Said here rather than only in the summary, because
          the fix is the "Add band" button directly underneath it. */}
      {problems[`${problemKey}-coverage`] ? (
        <div className="mt-3 rounded-lg border border-red-300 bg-red-50 px-3 py-2">
          <FieldError>{problems[`${problemKey}-coverage`]}</FieldError>
        </div>
      ) : null}

      <Button
        variant="secondary"
        size="sm"
        className="mt-3 h-11 w-full sm:h-9 sm:w-auto"
        onClick={() =>
          update({
            // Lands on the first unpriced stretch when there is one, so the usual
            // reason for pressing this is one tap rather than two dropdowns.
            priceRules: [
              ...config.priceRules,
              gapBands(config.priceRules, config.openMin, config.closeMin, slotMinutes)[0] ?? {
                fromMin: config.openMin,
                toMin: config.closeMin,
                price: UNSET,
              },
            ],
          })
        }
      >
        <Plus className="h-4 w-4" aria-hidden="true" />
        Add band
      </Button>

      {rules.length > 0 && isSet(config.priceRules.at(-1)?.price ?? UNSET) ? (
        <p className="mt-4 text-sm text-ink-600">
          Example: a 2-hour evening booking would cost{" "}
          <strong>{formatCurrency((config.priceRules.at(-1)?.price ?? 0) * 2)}</strong>.
        </p>
      ) : null}
    </>
  );
}

/**
 * Weekday prices, and — for a ground that charges more when it is busy — a second
 * table for the days that do.
 *
 * The weekend table is off until it is turned on, and turning it off again clears
 * it rather than leaving prices nobody can see still in force.
 */
function HourlyPricing({
  config,
  update,
  problems,
}: {
  config: FacilityConfig;
  update: (patch: Partial<FacilityConfig>) => void;
  problems: Problems;
}) {
  const weekend = config.weekendPriceRules ?? [];
  const weekendDays = config.weekendDays ?? [5, 6, 0];
  const weekendOn = weekend.length > 0;

  return (
    <>
      <PriceBands
        idPrefix="rule"
        problemKey="weekday"
        problems={problems}
        slotMinutes={config.slotMinutes}
        title={weekendOn ? "Weekday prices" : "Price bands"}
        description={
          weekendOn
            ? "Charged on every day not ticked as a weekend below."
            : "A multi-hour booking costs the sum of its hours, so bands never need duplicating per duration."
        }
        rules={config.priceRules}
        openMin={config.openMin}
        closeMin={config.closeMin}
        onChange={(priceRules) => update({ priceRules })}
      />

      <div className="mt-6 rounded-lg border border-ink-200 p-4">
        <label className="flex items-start gap-3">
          <input
            type="checkbox"
            className="mt-1 h-4 w-4"
            checked={weekendOn}
            onChange={(e) =>
              update(
                e.target.checked
                  ? {
                      // Starts as a copy of the weekday table, so the owner edits
                      // prices rather than rebuilding the hours from scratch.
                      weekendPriceRules: config.priceRules.map((r) => ({ ...r })),
                      weekendDays: weekendDays.length > 0 ? weekendDays : [5, 6, 0],
                    }
                  : { weekendPriceRules: [] },
              )
            }
          />
          <span>
            <span className="font-medium text-ink-900">Charge different prices at the weekend</span>
            <span className="mt-0.5 block text-sm text-ink-600">
              Off means one price all week. Existing bookings keep what they were charged either way.
            </span>
          </span>
        </label>

        {weekendOn ? (
          <>
            <p className="field-label mt-4">Weekend days</p>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {WEEK.map(({ day, label }) => {
                const on = weekendDays.includes(day);
                return (
                  <button
                    key={day}
                    type="button"
                    aria-pressed={on}
                    onClick={() =>
                      update({
                        weekendDays: on ? weekendDays.filter((d: number) => d !== day) : [...weekendDays, day],
                      })
                    }
                    className={cn(
                      "h-11 w-14 rounded-lg border text-sm font-semibold transition-colors sm:h-9",
                      on
                        ? "border-pitch-600 bg-pitch-600 text-white"
                        : problems.weekendDays
                          ? "border-red-400 bg-white text-ink-700"
                          : "border-ink-200 bg-white text-ink-700 hover:border-pitch-500",
                    )}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
            {problems.weekendDays ? <FieldError>{problems.weekendDays}</FieldError> : null}

            <PriceBands
              idPrefix="weekend-rule"
              problemKey="weekend"
              problems={problems}
              slotMinutes={config.slotMinutes}
              title="Weekend prices"
              description="Charged on the days ticked above. Cover the same hours as the weekday bands."
              rules={weekend}
              openMin={config.openMin}
              closeMin={config.closeMin}
              minBands={0}
              onChange={(weekendPriceRules) => update({ weekendPriceRules })}
            />
          </>
        ) : null}
      </div>
    </>
  );
}

/**
 * Bowling-machine pricing.
 *
 * The owner sells in blocks of overs — "₹180 for 10 overs" — so that is exactly
 * what is typed in, and a longer session is that price per block. The table
 * underneath shows what a customer actually pays, because that is the number the
 * owner is really deciding.
 */
function OversPricing({
  config,
  update,
  problems,
}: {
  config: FacilityConfig;
  update: (patch: Partial<FacilityConfig>) => void;
  problems: Problems;
}) {
  const block = config.oversPerSlot || 10;
  /** A few blocks worth previewing; sessions are not capped at these. */
  const preview = [1, 2, 3, 4, 5, 6].map((slots) => slots * block);
  const priceFor = (ball: BallType, overs: number) => ball.pricePerSlot * (overs / block);

  return (
    <>
      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        <div>
          <label className="field-label" htmlFor="overs-per-slot">
            Overs per {config.slotMinutes}-minute block
          </label>
          <PriceInput
            id="overs-per-slot"
            min={1}
            max={100}
            value={config.oversPerSlot}
            invalid={Boolean(problems.oversPerSlot)}
            describedBy={problems.oversPerSlot ? "overs-per-slot-error" : undefined}
            onChange={(oversPerSlot) => update({ oversPerSlot })}
          />
          {problems.oversPerSlot ? <FieldError id="overs-per-slot-error">{problems.oversPerSlot}</FieldError> : null}
          <p className="mt-1.5 text-xs text-ink-500">
            This is the whole overs rule. Customers book in multiples of it, and each block costs one ball price.
          </p>
        </div>
        <div>
          <label className="field-label" htmlFor="pay-at-venue">
            Pay at the ground up to
          </label>
          <PriceInput
            id="pay-at-venue"
            min={0}
            value={config.payAtVenueMaxOvers}
            invalid={Boolean(problems.payAtVenueMaxOvers)}
            describedBy={problems.payAtVenueMaxOvers ? "pay-at-venue-error" : undefined}
            onChange={(payAtVenueMaxOvers) => update({ payAtVenueMaxOvers })}
          />
          {problems.payAtVenueMaxOvers ? (
            <FieldError id="pay-at-venue-error">{problems.payAtVenueMaxOvers}</FieldError>
          ) : null}
          <p className="mt-1.5 text-xs text-ink-500">
            Sessions this size or smaller are confirmed instantly with no online payment — the customer pays you when
            they arrive. Set 0 to always ask for payment first.
          </p>
        </div>
      </div>

      <h3 className="mt-6 font-medium text-ink-900">Ball types &amp; prices</h3>
      <p className="mt-1 text-sm text-ink-600">
        Price for one block of {block} overs. {block * 2} overs costs twice this, {block * 3} overs three times, and so
        on — there is no upper limit beyond closing time.
      </p>

      <ul className="mt-3 space-y-3 sm:space-y-2">
        {config.ballTypes.map((ball, index) => (
          <li
            key={index}
            className="grid grid-cols-2 items-end gap-2 rounded-lg border border-ink-200 p-3 sm:grid-cols-[1fr,1fr,auto] sm:border-0 sm:p-0"
          >
            <div>
              <label className="field-label text-xs" htmlFor={`ball-name-${index}`}>
                Ball
              </label>
              <input
                id={`ball-name-${index}`}
                className="field-input"
                aria-invalid={problems[`ball-name-${index}`] ? true : undefined}
                value={ball.name}
                onChange={(e) => {
                  const balls = [...config.ballTypes];
                  // The id is what a live hold points at, so renaming a ball must
                  // never change it — an in-flight booking would lose its price.
                  balls[index] = { ...ball, name: e.target.value };
                  update({ ballTypes: balls });
                }}
              />
            </div>
            <div>
              <label className="field-label text-xs" htmlFor={`ball-price-${index}`}>
                Price per {block} overs
              </label>
              <PriceInput
                id={`ball-price-${index}`}
                value={ball.pricePerSlot}
                invalid={Boolean(problems[`ball-price-${index}`])}
                describedBy={problems[`ball-price-${index}`] ? `ball-price-${index}-error` : undefined}
                onChange={(pricePerSlot) => {
                  const balls = [...config.ballTypes];
                  balls[index] = { ...ball, pricePerSlot };
                  update({ ballTypes: balls });
                }}
              />
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="h-11 w-11 justify-self-end sm:h-9 sm:w-auto"
              aria-label={`Remove ${ball.name}`}
              onClick={() => update({ ballTypes: config.ballTypes.filter((_, i) => i !== index) })}
              disabled={config.ballTypes.length === 1}
            >
              <Trash2 className="h-4 w-4" aria-hidden="true" />
            </Button>
            {problems[`ball-name-${index}`] || problems[`ball-price-${index}`] ? (
              <div className="col-span-2 sm:col-span-3">
                {problems[`ball-name-${index}`] ? <FieldError>{problems[`ball-name-${index}`]}</FieldError> : null}
                {problems[`ball-price-${index}`] ? (
                  <FieldError id={`ball-price-${index}-error`}>{problems[`ball-price-${index}`]}</FieldError>
                ) : null}
              </div>
            ) : null}
          </li>
        ))}
      </ul>

      <Button
        variant="secondary"
        size="sm"
        className="mt-3 h-11 w-full sm:h-9 sm:w-auto"
        onClick={() =>
          update({
            ballTypes: [
              ...config.ballTypes,
              { id: `ball-${config.ballTypes.length + 1}`, name: "New ball", pricePerSlot: 150 },
            ],
          })
        }
      >
        <Plus className="h-4 w-4" aria-hidden="true" />
        Add ball type
      </Button>

      {config.ballTypes.length > 0 ? (
        <div className="mt-5 overflow-x-auto rounded-lg border border-ink-200">
          <table className="w-full text-sm">
            <caption className="px-3 pt-3 text-left text-xs font-medium text-ink-600">
              What a customer will actually pay
            </caption>
            <thead>
              <tr className="text-left text-xs text-ink-600">
                <th scope="col" className="px-3 py-2 font-medium">Session</th>
                {config.ballTypes.map((b, i) => (
                  <th key={i} scope="col" className="px-3 py-2 font-medium">
                    {b.name || "Ball"}
                  </th>
                ))}
                <th scope="col" className="px-3 py-2 font-medium">Pay</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {preview.map((overs) => {
                const minutes = (overs / block) * config.slotMinutes;
                const atVenue = config.payAtVenueMaxOvers > 0 && overs <= config.payAtVenueMaxOvers;
                return (
                  <tr key={overs}>
                    <th scope="row" className="whitespace-nowrap px-3 py-2 text-left font-medium text-ink-900">
                      {overs} overs
                      <span className="ml-1 font-normal text-ink-500">({minutesToDuration(minutes)})</span>
                    </th>
                    {config.ballTypes.map((b, j) => (
                      <td key={j} className="whitespace-nowrap px-3 py-2 tabular-nums text-ink-800">
                        {formatCurrency(priceFor(b, overs))}
                      </td>
                    ))}
                    <td className="whitespace-nowrap px-3 py-2 text-xs text-ink-600">
                      {atVenue ? "At the ground" : "Online first"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="px-3 pb-3 pt-1 text-xs text-ink-500">
            Customers can book beyond this — as many blocks as the day has room for.
          </p>
        </div>
      ) : null}
    </>
  );
}

function Text({
  label,
  value,
  onChange,
  hint,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
}) {
  const id = React.useId();
  return (
    <div>
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      <input id={id} className="field-input" value={value} onChange={(e) => onChange(e.target.value)} />
      {hint ? <p className="mt-1.5 text-xs text-ink-500">{hint}</p> : null}
    </div>
  );
}
