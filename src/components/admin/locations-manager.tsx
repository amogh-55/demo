"use client";

import * as React from "react";
import { Plus, Trash2 } from "lucide-react";
import { api, errorMessage } from "@/lib/client";
import { formatMinutes } from "@/lib/time";
import { Alert, Button, Spinner, cn, formatCurrency } from "@/components/ui/primitives";

interface AdminLocation {
  id: string;
  name: string;
  slug: string;
  address: string;
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

interface SlotConfig {
  slotMinutes: number;
  openMin: number;
  closeMin: number;
  priceRules: PriceRule[];
  bookingWindowDays: number;
  holdMinutes: number;
}

const HOURS = Array.from({ length: 25 }, (_, i) => i * 60);

export function LocationsManager({ initialLocations }: { initialLocations: AdminLocation[] }) {
  const [locations, setLocations] = React.useState(initialLocations);
  const [selectedId, setSelectedId] = React.useState(initialLocations[0]?.id ?? "");
  const [notice, setNotice] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const selected = locations.find((l) => l.id === selectedId);

  async function refresh() {
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
      await refresh();
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
          {locations.map((l) => (
            <li key={l.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <button type="button" className="min-w-0 flex-1 py-1 text-left" onClick={() => setSelectedId(l.id)}>
                <span className={cn("block truncate font-medium", selectedId === l.id ? "text-pitch-700" : "text-ink-900")}>
                  {l.name}
                </span>
                <span className="mt-0.5 block truncate text-sm text-ink-500">{l.address}</span>
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
          ))}
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
            Details, hours and pricing below apply to this ground only.
          </p>
        </section>
      ) : null}

      {selected ? <LocationEditor key={selected.id} location={selected} onSaved={refresh} /> : null}
      {selected ? <ScheduleEditor key={selected.id} locationId={selected.id} locationName={selected.name} /> : null}
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

function ScheduleEditor({ locationId, locationName }: { locationId: string; locationName: string }) {
  const [config, setConfig] = React.useState<SlotConfig | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [saved, setSaved] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void api<{ config: SlotConfig }>(`/api/admin/config?locationId=${locationId}`)
      .then((data) => !cancelled && setConfig(data.config))
      .catch((err) => !cancelled && setError(errorMessage(err)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [locationId]);

  async function save() {
    if (!config) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/admin/locations/${locationId}`, { method: "PUT", body: JSON.stringify(config) });
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <section className="card">
        <p className="flex items-center gap-2 text-sm text-ink-600">
          <Spinner /> Loading schedule…
        </p>
      </section>
    );
  }
  if (!config) return null;

  const update = (patch: Partial<SlotConfig>) => setConfig({ ...config, ...patch });

  return (
    <section className="card">
      <h2 className="break-words font-semibold text-ink-900">Hours &amp; pricing · {locationName}</h2>
      <p className="mt-1 text-sm text-ink-600">
        Existing bookings keep the price they were charged. Changes only affect new bookings.
      </p>

      <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
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
        {/* Slot length and hold duration are deliberately not editable here. Both
            are load-bearing — slot length is the unit the double-booking index is
            built on, and changing it against existing bookings would split or merge
            the very rows that guarantee one booking per hour. They keep their saved
            values, which are still sent on save. */}
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

      <h3 className="mt-6 font-medium text-ink-900">Price bands</h3>
      <p className="mt-1 text-sm text-ink-600">
        A multi-hour booking costs the sum of its hours, so bands never need duplicating per duration.
      </p>
      {/* Three selects and a delete button in one row need desktop width; on a phone the
          band wraps to two rows and gets a border so the bands stay distinguishable. */}
      <ul className="mt-3 space-y-3 sm:space-y-2">
        {config.priceRules.map((rule, index) => (
          <li
            key={index}
            className="grid grid-cols-2 items-end gap-2 rounded-lg border border-ink-200 p-3 sm:grid-cols-[1fr,1fr,1fr,auto] sm:border-0 sm:p-0"
          >
            <div>
              <label className="field-label text-xs" htmlFor={`rule-from-${index}`}>
                From
              </label>
              <select
                id={`rule-from-${index}`}
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
              <label className="field-label text-xs" htmlFor={`rule-to-${index}`}>
                To
              </label>
              <select
                id={`rule-to-${index}`}
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
              <label className="field-label text-xs" htmlFor={`rule-price-${index}`}>
                Price per slot
              </label>
              <input
                id={`rule-price-${index}`}
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
              disabled={config.priceRules.length === 1}
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

      <p className="mt-4 text-sm text-ink-600">
        Example: a 2-hour evening booking would cost{" "}
        <strong>{formatCurrency((config.priceRules.at(-1)?.price ?? 0) * 2)}</strong>.
      </p>

      {error ? <Alert tone="error" className="mt-3">{error}</Alert> : null}

      <Button className="mt-4 w-full sm:w-auto" onClick={save} disabled={busy}>
        {busy ? <Spinner /> : null}
        {busy ? "Saving…" : saved ? "Saved" : "Save schedule"}
      </Button>
    </section>
  );
}

function Text({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  const id = React.useId();
  return (
    <div>
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      <input id={id} className="field-input" value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}
