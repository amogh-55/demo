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
  otpEnabled: boolean;
  razorpayEnabled: boolean;
  upiScreenshotEnabled: boolean;
  notifyPhone: string;
  notifyOnNewBooking: boolean;
}

export function SettingsForm({
  initial,
  smsReady,
  razorpay,
}: {
  initial: Settings;
  smsReady: boolean;
  /** What the deployment can actually do, as opposed to what the switch says. */
  razorpay: { ready: boolean; webhookReady: boolean; live: boolean };
}) {
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

      <section className="card">
        <h2 className="font-semibold text-ink-900">Online payment (Razorpay)</h2>
        <p className="mt-1 text-sm text-ink-600">
          Lets customers pay by card, UPI or netbanking while they book. Those bookings confirm themselves — there is no
          screenshot for you to check.
        </p>

        {!razorpay.ready ? (
          <Alert tone="warning" className="mt-3">
            No Razorpay keys are connected to this deployment, so this switch does nothing yet. Add them before turning
            it on.
          </Alert>
        ) : !razorpay.webhookReady ? (
          <Alert tone="warning" className="mt-3">
            The webhook secret is missing. Payments will still work, but if a customer loses connection just after
            paying, their booking will not confirm itself. Add RAZORPAY_WEBHOOK_SECRET.
          </Alert>
        ) : (
          <Alert tone={razorpay.live ? "warning" : "info"} className="mt-3">
            {razorpay.live
              ? "LIVE keys are connected. Payments taken here move real money."
              : "TEST keys are connected. No real money moves — use Razorpay's test cards."}
          </Alert>
        )}

        <div className="mt-4 space-y-3">
          <Toggle
            label="Take payments online with Razorpay"
            hint="Customers pay by card, UPI or netbanking and the booking confirms itself."
            checked={form.razorpayEnabled}
            onChange={(razorpayEnabled) => set({ razorpayEnabled })}
          />

          {/*
            Nested, because it only means anything while the gateway is on, and
            phrased as the thing being switched ON rather than the thing being
            kept: "accept online only" is the decision the owner is making, and an
            unticked box is the safe state to land on.

            The stored field is the opposite — upiScreenshotEnabled, defaulting to
            true — so that a settings document written before this existed, or one
            missing the field for any reason, reads as "screenshots still work"
            rather than as a site that has quietly stopped taking them.
          */}
          <div className="sm:pl-6">
            <Toggle
              label="Accept online payments only"
              hint="Hides the UPI + screenshot option, so customers can only pay by card, UPI or netbanking. Untick it if Razorpay starts giving customers trouble."
              checked={!form.upiScreenshotEnabled}
              onChange={(onlineOnly) => set({ upiScreenshotEnabled: !onlineOnly })}
            />
          </div>
        </div>

        {/*
          The one combination that would take the site off sale. Said as a fact
          rather than prevented, because the server already ignores the switch in
          exactly this case — but the owner should know why their change appears
          to have done nothing.
        */}
        {!form.upiScreenshotEnabled && (!form.razorpayEnabled || !razorpay.ready) ? (
          <Alert tone="warning" className="mt-3">
            Online payment is not running, so customers are still being offered the UPI screenshot option — otherwise
            they would have no way to pay at all. This takes effect once Razorpay is switched on above.
          </Alert>
        ) : !form.upiScreenshotEnabled ? (
          <Alert tone="info" className="mt-3">
            Customers will only be offered card, UPI and netbanking through Razorpay. Nobody can book by sending a
            screenshot.
          </Alert>
        ) : null}
      </section>

      <section className="card">
        <h2 className="font-semibold text-ink-900">SMS</h2>
        <p className="mt-1 text-sm text-ink-600">
          Both of these send text messages, which your SMS provider charges you for. They start switched off, and
          nothing is sent until you turn them on.
        </p>

        {!smsReady ? (
          <Alert tone="warning" className="mt-3">
            No SMS provider is connected yet, so no message can actually be delivered. Add your provider keys to the
            deployment before switching these on.
          </Alert>
        ) : null}

        <div className="mt-4 space-y-3">
          <Toggle
            label="Ask customers to verify their mobile number"
            hint="Customers get a 4-digit code before they can book. Catches mistyped numbers, so you can always reach them."
            checked={form.otpEnabled}
            onChange={(otpEnabled) => set({ otpEnabled })}
          />
          <Toggle
            label="Text me when a booking comes in"
            hint="One message per new booking, with the reference and the amount."
            checked={form.notifyOnNewBooking}
            onChange={(notifyOnNewBooking) => set({ notifyOnNewBooking })}
          />
        </div>

        {form.notifyOnNewBooking ? (
          <div className="mt-4 sm:max-w-xs">
            <Field
              label="Send alerts to"
              value={form.notifyPhone}
              onChange={(notifyPhone) => set({ notifyPhone })}
              hint="Leave blank to use the support number above."
            />
          </div>
        ) : null}
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

/** A whole row is the tap target — a bare checkbox is a poor one on a phone. */
function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const id = React.useId();
  return (
    <label
      htmlFor={id}
      className="flex cursor-pointer items-start gap-3 rounded-lg border border-ink-200 p-3 transition-colors hover:bg-ink-50"
    >
      <input
        id={id}
        type="checkbox"
        className="mt-0.5 h-5 w-5 shrink-0 accent-pitch-600"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="min-w-0">
        <span className="block text-sm font-medium text-ink-900">{label}</span>
        <span className="mt-0.5 block text-xs text-ink-600">{hint}</span>
      </span>
    </label>
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
