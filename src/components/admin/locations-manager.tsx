"use client";

import * as React from "react";
import { Plus, Trash2 } from "lucide-react";
import { api, errorMessage } from "@/lib/client";
import { formatMinutes, minutesToDuration } from "@/lib/time";
import { Alert, Button, Spinner, cn, formatCurrency } from "@/components/ui/primitives";

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

/** "Bowling Machine" → "bowling-machine", for the slug fields. */
function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

export function LocationsManager({ initialLocations }: { initialLocations: AdminLocation[] }) {
  const [locations, setLocations] = React.useState(initialLocations);
  const [selectedId, setSelectedId] = React.useState(initialLocations[0]?.id ?? "");
  const [tree, setTree] = React.useState<Tree>({ facilities: [], resources: [] });
  const [notice, setNotice] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const selected = locations.find((l) => l.id === selectedId);

  const refreshTree = React.useCallback(async () => {
    try {
      const data = await api<Tree>("/api/admin/facilities");
      setTree({ facilities: data.facilities, resources: data.resources });
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  React.useEffect(() => {
    void refreshTree();
  }, [refreshTree]);

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
  const [newName, setNewName] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function add() {
    if (busy || newName.trim().length < 1) return;
    setBusy(true);
    setError(null);
    try {
      await api("/api/admin/resources", {
        method: "POST",
        body: JSON.stringify({
          facilityId: facility.id,
          name: newName.trim(),
          slug: slugify(`${facility.slug}-${newName}`),
          sortOrder: resources.length,
        }),
      });
      setNewName("");
      await onChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

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

      <div className="mt-3 grid gap-3 sm:grid-cols-[1fr,auto] sm:items-end">
        <Text label="Add another (e.g. Court 2)" value={newName} onChange={setNewName} />
        <Button className="h-11 sm:h-[42px]" onClick={add} disabled={busy || newName.trim().length < 1}>
          {busy ? <Spinner /> : null}
          Add
        </Button>
      </div>

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
  const update = (patch: Partial<FacilityConfig>) => setConfig({ ...config, ...patch });

  async function save() {
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
          <select id="close-min" className="field-input" value={config.closeMin} onChange={(e) => update({ closeMin: Number(e.target.value) })}>
            {HOURS.slice(1).map((m) => (
              <option key={m} value={m}>
                {m === 1440 ? "12:00 AM (midnight)" : formatMinutes(m)}
              </option>
            ))}
          </select>
        </div>
        {/* Slot length and hold duration are deliberately not editable here. Slot
            length is the unit the double-booking index is built on — the server
            refuses to change it under live bookings — and it is decided by how the
            facility is sold: an hour for play, a quarter-hour for a machine. */}
        <div>
          <label className="field-label" htmlFor="window-days">
            Booking window (days ahead)
          </label>
          <input
            id="window-days"
            type="number"
            min={0}
            max={365}
            className="field-input"
            value={config.bookingWindowDays}
            onChange={(e) => update({ bookingWindowDays: Number(e.target.value) })}
          />
        </div>
      </div>

      {isOvers ? (
        <OversPricing config={config} update={update} />
      ) : (
        <HourlyPricing config={config} update={update} />
      )}

      {error ? <Alert tone="error" className="mt-3">{error}</Alert> : null}

      <Button className="mt-4 w-full sm:w-auto" onClick={save} disabled={busy}>
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
  title,
  description,
  rules,
  openMin,
  closeMin,
  onChange,
  minBands = 1,
}: {
  idPrefix: string;
  title: string;
  description: string;
  rules: PriceRule[];
  openMin: number;
  closeMin: number;
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
              <input
                id={`${idPrefix}-price-${index}`}
                type="number"
                min={0}
                className="field-input"
                value={rule.price}
                onChange={(e) => {
                  const rules = [...config.priceRules];
                  rules[index] = { ...rule, price: Number(e.target.value) };
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
          </li>
        ))}
      </ul>

      <Button
        variant="secondary"
        size="sm"
        className="mt-3 h-11 w-full sm:h-9 sm:w-auto"
        onClick={() =>
          update({
            priceRules: [
              ...config.priceRules,
              { fromMin: config.openMin, toMin: config.closeMin, price: config.priceRules.at(-1)?.price ?? 800 },
            ],
          })
        }
      >
        <Plus className="h-4 w-4" aria-hidden="true" />
        Add band
      </Button>

      {rules.length > 0 ? (
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
}: {
  config: FacilityConfig;
  update: (patch: Partial<FacilityConfig>) => void;
}) {
  const weekend = config.weekendPriceRules ?? [];
  const weekendDays = config.weekendDays ?? [5, 6, 0];
  const weekendOn = weekend.length > 0;

  return (
    <>
      <PriceBands
        idPrefix="rule"
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
                        : "border-ink-200 bg-white text-ink-700 hover:border-pitch-500",
                    )}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
            {weekendDays.length === 0 ? (
              <p className="mt-2 text-sm text-amber-700">Pick at least one day, or turn weekend pricing off.</p>
            ) : null}

            <PriceBands
              idPrefix="weekend-rule"
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
}: {
  config: FacilityConfig;
  update: (patch: Partial<FacilityConfig>) => void;
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
          <input
            id="overs-per-slot"
            type="number"
            min={1}
            max={100}
            className="field-input"
            value={config.oversPerSlot}
            onChange={(e) => update({ oversPerSlot: Number(e.target.value) })}
          />
          <p className="mt-1.5 text-xs text-ink-500">
            This is the whole overs rule. Customers book in multiples of it, and each block costs one ball price.
          </p>
        </div>
        <div>
          <label className="field-label" htmlFor="pay-at-venue">
            Pay at the ground up to
          </label>
          <input
            id="pay-at-venue"
            type="number"
            min={0}
            step={block}
            className="field-input"
            value={config.payAtVenueMaxOvers}
            onChange={(e) => update({ payAtVenueMaxOvers: Number(e.target.value) })}
          />
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
              <input
                id={`ball-price-${index}`}
                type="number"
                min={0}
                className="field-input"
                value={ball.pricePerSlot}
                onChange={(e) => {
                  const balls = [...config.ballTypes];
                  balls[index] = { ...ball, pricePerSlot: Number(e.target.value) };
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
