"use client";

import * as React from "react";
import { api, errorMessage } from "@/lib/client";
import { Alert, Button, Spinner } from "@/components/ui/primitives";

interface Settings {
  businessName: string;
  supportPhone: string;
  whatsappNumber: string;
  upiId: string;
  upiPayeeName: string;
  upiQrImageUrl: string;
}

export function SettingsForm({ initial }: { initial: Settings }) {
  const [form, setForm] = React.useState(initial);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [saved, setSaved] = React.useState(false);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api("/api/admin/settings", { method: "PUT", body: JSON.stringify(form) });
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2500);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const set = (patch: Partial<Settings>) => setForm({ ...form, ...patch });

  return (
    <form onSubmit={save} className="space-y-4">
      <section className="card">
        <h2 className="font-semibold text-ink-900">Business</h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <Field label="Business name" value={form.businessName} onChange={(businessName) => set({ businessName })} />
          <Field
            label="Support phone"
            value={form.supportPhone}
            onChange={(supportPhone) => set({ supportPhone })}
            hint="10-digit mobile number"
          />
          <Field
            label="WhatsApp number"
            value={form.whatsappNumber}
            onChange={(whatsappNumber) => set({ whatsappNumber })}
            hint="Used for the customer contact buttons"
          />
        </div>
      </section>

      <section className="card">
        <h2 className="font-semibold text-ink-900">UPI payment</h2>
        <p className="mt-1 text-sm text-ink-600">
          Shown to customers on the payment step. Payments are never taken automatically — you verify every screenshot.
        </p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <Field label="UPI ID" value={form.upiId} onChange={(upiId) => set({ upiId })} hint="e.g. turf@okicici" />
          <Field label="Payee name" value={form.upiPayeeName} onChange={(upiPayeeName) => set({ upiPayeeName })} />
          <div className="sm:col-span-2">
            <Field
              label="UPI QR image URL"
              value={form.upiQrImageUrl}
              onChange={(upiQrImageUrl) => set({ upiQrImageUrl })}
              hint="Path or URL of the QR image customers scan"
            />
          </div>
        </div>
      </section>

      {error ? <Alert tone="error">{error}</Alert> : null}
      {saved ? <Alert tone="success">Settings saved.</Alert> : null}

      <Button type="submit" className="w-full sm:w-auto" disabled={busy}>
        {busy ? <Spinner /> : null}
        {busy ? "Saving…" : "Save settings"}
      </Button>
    </form>
  );
}

function Field({
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
      {hint ? <p className="mt-1 text-xs text-ink-500">{hint}</p> : null}
    </div>
  );
}
