"use client";

import * as React from "react";
import { api, errorMessage } from "@/lib/client";
import { Alert, Button, Spinner, cn } from "@/components/ui/primitives";

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
  emailOnBooking: boolean;
  emailOnPhoneBooking: boolean;
}

/** The Business card saves on its own; everything else is the payments-and-notifications half. */
type Part = "business" | "rest";
const BUSINESS_FIELDS = ["businessName", "supportPhone", "whatsappNumber"] as const;

export function SettingsForm({
  initial,
  smsReady,
  razorpay,
  email,
  children,
}: {
  initial: Settings;
  smsReady: boolean;
  /** What the deployment can actually do, as opposed to what the switch says. */
  razorpay: { ready: boolean; webhookReady: boolean; live: boolean };
  /** Same idea for email: the switch is the owner's, the plumbing is the deployment's. */
  email: { ready: boolean; address: string };
  /** The grounds and prices, which sit between the Business card and the payment ones. */
  children?: React.ReactNode;
}) {
  const [form, setForm] = React.useState(initial);
  /** What the server holds now. Each Save sends this plus its own cards' edits only. */
  const stored = React.useRef(initial);
  const [busy, setBusy] = React.useState<Part | null>(null);
  const [outcome, setOutcome] = React.useState<{ part: Part; error: string | null } | null>(null);

  /*
   * Two Save buttons, because the grounds and prices now sit between the
   * Business card and the rest and a single button at the very bottom would be
   * several screens away from the business name. Each saves only its own
   * cards: pressing Save under the business name must not also switch on a
   * payment box ticked further down and forgotten about. The API takes the
   * whole document — and reads a missing switch as OFF — so the rest of what
   * is sent is the last saved copy, not the half-edited one on screen.
   */
  const save = (part: Part) => async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const business = Object.fromEntries(BUSINESS_FIELDS.map((k) => [k, form[k]]));
    const storedBusiness = Object.fromEntries(BUSINESS_FIELDS.map((k) => [k, stored.current[k]]));
    const body: Settings = part === "business" ? { ...stored.current, ...business } : { ...form, ...storedBusiness };
    setBusy(part);
    setOutcome(null);
    try {
      await api("/api/admin/settings", { method: "PUT", body: JSON.stringify(body) });
      stored.current = body;
      setOutcome({ part, error: null });
      window.setTimeout(() => setOutcome((now) => (now?.part === part && !now.error ? null : now)), 2500);
    } catch (err) {
      setOutcome({ part, error: errorMessage(err) });
    } finally {
      setBusy(null);
    }
  };

  const set = (patch: Partial<Settings>) => setForm({ ...form, ...patch });

  const saveRow = (part: Part, label: string) => (
    <div className="space-y-3">
      {outcome?.part === part && outcome.error ? <Alert tone="error">{outcome.error}</Alert> : null}
      {outcome?.part === part && !outcome.error ? <Alert tone="success">Saved.</Alert> : null}
      <Button type="submit" className="w-full sm:w-auto" disabled={busy !== null}>
        {busy === part ? <Spinner /> : null}
        {busy === part ? "Saving…" : label}
      </Button>
    </div>
  );

  return (
    <div className="space-y-4">
      <form onSubmit={save("business")} className="card">
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
        <div className="mt-4">{saveRow("business", "Save business details")}</div>
      </form>

      {children}

      <form onSubmit={save("rest")} className="space-y-4">
        <section className="card">
          <h2 className="font-semibold text-ink-900">UPI payment</h2>
          <p className="mt-1 text-sm text-ink-600">
            Shown to customers on the payment step. Payments are never taken automatically — you verify every
            screenshot.
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
            Customers pay by card, UPI or netbanking while they book, and the booking confirms itself. Nothing for you
            to check.
          </p>

          {!razorpay.ready ? (
            <Alert tone="warning" className="mt-3">
              Razorpay is not connected to this site yet, so the boxes below will not do anything. The keys have to be
              added first.
            </Alert>
          ) : !razorpay.webhookReady ? (
            <Alert tone="warning" className="mt-3">
              Almost set up. Payments will work, but if a customer loses signal right after paying, their booking will
              not confirm on its own and you will have to do it by hand. Add RAZORPAY_WEBHOOK_SECRET to finish.
            </Alert>
          ) : (
            <Alert tone={razorpay.live ? "warning" : "info"} className="mt-3">
              {razorpay.live ? "Live mode — real money moves." : "Test mode — no real money moves."}
            </Alert>
          )}

          <div className="mt-4 space-y-3">
            <Toggle
              label="Use Razorpay"
              hint="Customers pay by card, UPI or netbanking, and the booking confirms itself."
              checked={form.razorpayEnabled}
              onChange={(razorpayEnabled) => set({ razorpayEnabled })}
            />

            {/*
            Nested, because it only means anything while the gateway is on, and
            phrased as the thing being switched ON rather than the thing being
            kept: "online payment only" is the decision the owner is making, and
            an unticked box is the safe state to land on.

            The stored field is the opposite — upiScreenshotEnabled, defaulting to
            true — so that a settings document written before this existed, or one
            missing the field for any reason, reads as "screenshots still work"
            rather than as a site that has quietly stopped taking them.
          */}
            <div className="sm:pl-6">
              <Toggle
                label="Disable screenshot payment"
                hint="Customers can only pay through Razorpay. Untick this when Razorpay fails."
                checked={!form.upiScreenshotEnabled}
                onChange={(onlineOnly) => set({ upiScreenshotEnabled: !onlineOnly })}
              />
            </div>
          </div>

          {/*
          One line for all four combinations, instead of three alerts the owner
          has to assemble in their head — including the combination that would
          take the site off sale, which the server already ignores. Saying what
          customers see right now is the only question these two boxes answer.
        */}
          <p className="mt-3 rounded-lg border border-ink-200 bg-ink-50 px-3 py-2 text-sm text-ink-700">
            <span className="font-medium text-ink-900">Right now: </span>
            {form.razorpayEnabled && razorpay.ready
              ? form.upiScreenshotEnabled
                ? "customers choose — pay online, or pay by UPI and send you a screenshot to check."
                : "customers can only pay online. Nobody can book by sending a screenshot."
              : form.upiScreenshotEnabled
                ? "customers pay by UPI and send you a screenshot, and you check each one."
                : "customers pay by UPI and send you a screenshot. “Disable screenshot payment” does nothing until you tick “Use Razorpay” above."}
          </p>

          {/*
          Answers the question every owner asks before touching a live payment
          switch. True by construction: the verify route and the webhook settle a
          payment from Razorpay's own record and never read either box.
        */}
          <p className="mt-2 text-xs text-ink-500">
            Safe to change at any time — a customer who is already paying is not affected, and money on its way still
            lands on their booking.
          </p>
        </section>

        <section className="card">
          <h2 className="font-semibold text-ink-900">Notifications</h2>
          <p className="mt-1 text-sm text-ink-600">
            Bookings come to you by email. The only text messages this site sends are the verification codes customers
            type in while booking.
          </p>

          {!email.ready ? (
            <Alert tone="warning" className="mt-3">
              Email is not set up on this site yet, so nothing can be sent to you. RESEND_API_KEY, RESEND_FROM_EMAIL and
              OWNER_EMAIL have to be added first.
            </Alert>
          ) : null}

          {!smsReady ? (
            <Alert tone="warning" className="mt-3">
              No SMS provider is connected yet, so no verification code can be delivered. Add your provider keys to the
              deployment before switching that on.
            </Alert>
          ) : null}

          <div className="mt-4 space-y-3">
            <Toggle
              label="Email me every confirmed booking"
              hint={
                email.address
                  ? `One email per booking, sent to ${email.address}, with the customer, the slot and what they paid.`
                  : "One email per booking, with the customer, the slot and what they paid."
              }
              checked={form.emailOnBooking}
              onChange={(emailOnBooking) => set({ emailOnBooking })}
            />
            {/* Under the main switch, because it only means anything while that is on. */}
            <div className="sm:pl-6">
              <Toggle
                label="Email me phone bookings too"
                hint="Untick to save your free email allowance: you took these bookings yourself, so you already know about them."
                checked={form.emailOnBooking && form.emailOnPhoneBooking}
                disabled={!form.emailOnBooking}
                onChange={(emailOnPhoneBooking) => set({ emailOnPhoneBooking })}
              />
            </div>
            <Toggle
              label="Ask customers to verify their mobile number"
              hint="Customers get a 4-digit code by SMS before they can book. Catches mistyped numbers, so you can always reach them."
              checked={form.otpEnabled}
              onChange={(otpEnabled) => set({ otpEnabled })}
            />
          </div>

          {/*
          Said plainly because unticking the email box looks like it stops all
          email, and an owner who thinks that would wonder why customers still
          thank them for the receipt.
        */}
          <p className="mt-2 text-xs text-ink-500">
            The email box is only about your copy. A customer who types their email address while booking always gets
            their own, and money problems that need you to act are always emailed whatever this says.
          </p>
        </section>

        {saveRow("rest", "Save payment & notification settings")}
      </form>
    </div>
  );
}

/** A whole row is the tap target — a bare checkbox is a poor one on a phone. */
function Toggle({
  label,
  hint,
  checked,
  disabled = false,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  const id = React.useId();
  return (
    <label
      htmlFor={id}
      className={cn(
        "flex items-start gap-3 rounded-lg border border-ink-200 p-3 transition-colors",
        disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer hover:bg-ink-50",
      )}
    >
      <input
        id={id}
        type="checkbox"
        className="mt-0.5 h-5 w-5 shrink-0 accent-pitch-600"
        checked={checked}
        disabled={disabled}
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
