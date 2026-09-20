"use client";

import * as React from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { ExternalLink, Image as ImageIcon } from "lucide-react";
import { Alert, Button, Spinner, cn, formatCurrency } from "@/components/ui/primitives";
import { ReasonPicker } from "@/components/ui/reason-picker";
import { formatIstTimestamp } from "@/lib/time";

export interface PaymentAttemptView {
  id: string;
  uploadedAt: string;
  amount: number | null;
  status: "PENDING" | "ACCEPTED" | "REJECTED";
  note: string | null;
  /** False for a payment the admin recorded by hand — there is no image to open. */
  hasScreenshot?: boolean;
}

export interface PaymentReviewBooking {
  id: string;
  reference: string;
  customerName: string;
  amount: number;
  amountPaid: number;
  amountRemaining: number;
  payments: PaymentAttemptView[];
}

const REJECT_NOTES = ["Screenshot is unclear", "Payment not received", "Screenshot is for another booking", "Duplicate screenshot"];

/** Where money arrives when there is no screenshot in the booking flow behind it. */
const MANUAL_SOURCES = ["Sent on WhatsApp", "Paid in cash at the ground", "Confirmed in bank statement", "Paid from another phone"];

/**
 * Reviewing a payment is about money, not about the booking's fate. Nothing in
 * this dialog can release a slot — that is a separate, explicit action.
 */
export function PaymentReviewDialog({
  booking,
  open,
  onOpenChange,
  busy,
  error,
  onAccept,
  onReject,
  onRecord,
}: {
  booking: PaymentReviewBooking | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  busy: boolean;
  error: string | null;
  onAccept: (attemptId: string, amount: number, note?: string) => void;
  onReject: (attemptId: string, note: string) => void;
  onRecord: (amount: number, note: string) => void;
}) {
  const pending = booking?.payments.find((p) => p.status === "PENDING") ?? null;
  const [amount, setAmount] = React.useState("");
  const [note, setNote] = React.useState("");
  const [mode, setMode] = React.useState<"ACCEPT" | "REJECT">("ACCEPT");
  /** Recording money with no screenshot behind it — paid on WhatsApp, or in cash. */
  const [manual, setManual] = React.useState(false);

  React.useEffect(() => {
    if (!open || !booking) return;
    // Pre-fill with what is still owed: the common case is a payment in full.
    setAmount(String(booking.amountRemaining || booking.amount));
    setNote("");
    setMode("ACCEPT");
    // With nothing left to review, recording a payment is the only useful action,
    // so open straight into it rather than showing a dead end.
    setManual(booking.payments.every((p) => p.status !== "PENDING"));
  }, [open, booking]);

  if (!booking) return null;

  const parsed = Number(amount);
  const amountValid = Number.isFinite(parsed) && parsed > 0;
  const projectedPaid = booking.amountPaid + (amountValid ? parsed : 0);
  const projectedRemaining = booking.amount - projectedPaid;

  return (
    <Dialog.Root open={open} onOpenChange={(next) => (busy ? null : onOpenChange(next))}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-ink-950/50 backdrop-blur-sm" />
        {/* dvh, not vh: with the keyboard up, vh still measures the un-shrunk phone viewport. */}
        <Dialog.Content className="theme-light fixed left-1/2 top-1/2 z-50 max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl bg-white p-5 shadow-xl focus:outline-none">
          <Dialog.Title className="text-lg font-semibold text-ink-900">Review payment</Dialog.Title>
          <Dialog.Description className="mt-1 break-words text-sm text-ink-600">
            {booking.reference} · {booking.customerName}
          </Dialog.Description>

          {/* Where the money stands right now. */}
          {/* break-words is inherited, so a five-figure amount wraps instead of spilling out
              of its third of a 320px screen. */}
          <dl className="mt-4 grid grid-cols-3 gap-2 break-words rounded-lg border border-ink-200 bg-ink-50 p-3 text-center text-sm">
            <div>
              <dt className="text-xs text-ink-500">Booking total</dt>
              <dd className="mt-0.5 font-semibold text-ink-900">{formatCurrency(booking.amount)}</dd>
            </div>
            <div>
              <dt className="text-xs text-ink-500">Received</dt>
              <dd className="mt-0.5 font-semibold text-ink-900">{formatCurrency(booking.amountPaid)}</dd>
            </div>
            <div>
              <dt className="text-xs text-ink-500">Outstanding</dt>
              <dd className={cn("mt-0.5 font-bold", booking.amountRemaining > 0 ? "text-amber-700" : "text-green-700")}>
                {formatCurrency(booking.amountRemaining)}
              </dd>
            </div>
          </dl>

          {booking.payments.length > 1 ? (
            <ul className="mt-3 space-y-1 text-xs">
              {booking.payments.map((p, i) => (
                <li key={p.id} className="flex items-center justify-between gap-2 rounded bg-ink-50 px-2 py-1">
                  <a
                    href={`/api/admin/bookings/${booking.id}/screenshot?attempt=${encodeURIComponent(p.id)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex h-11 min-w-0 items-center truncate text-ink-600 underline decoration-dotted underline-offset-2 hover:text-pitch-700"
                  >
                    #{i + 1} · {formatIstTimestamp(p.uploadedAt)}
                  </a>
                  <span
                    className={cn(
                      "shrink-0 font-medium",
                      p.status === "ACCEPTED" ? "text-green-700" : p.status === "REJECTED" ? "text-ink-500 line-through" : "text-amber-700",
                    )}
                  >
                    {p.amount !== null ? formatCurrency(p.amount) : p.status === "PENDING" ? "awaiting review" : "not counted"}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}

          {manual || !pending ? (
            <div className="mt-4">
              {!pending ? (
                <p className="text-sm text-ink-600">
                  Every screenshot sent so far has been reviewed. If the customer has paid since — on WhatsApp, in cash,
                  or from another phone — record it here.
                </p>
              ) : null}

              <label className="field-label mt-3" htmlFor="manual-amount">
                How much did you receive?
              </label>
              <input
                id="manual-amount"
                type="number"
                min={1}
                inputMode="numeric"
                className="field-input"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />

              <div className="mt-3">
                <ReasonPicker
                  key={`manual-${booking.id}-${String(open)}`}
                  id="manual-note"
                  label="Where did it come from?"
                  options={MANUAL_SOURCES}
                  value={note}
                  onChange={setNote}
                  placeholder="There is no screenshot behind this, so say where the money came from"
                />
              </div>

              {amountValid ? (
                <Alert tone={projectedRemaining > 0 ? "warning" : "success"} className="mt-3">
                  {projectedRemaining > 0 ? (
                    <>
                      Still short by <strong>{formatCurrency(projectedRemaining)}</strong>. The booking stays pending and{" "}
                      <strong>keeps its slots</strong>.
                    </>
                  ) : (
                    <>
                      Paid in full{projectedRemaining < 0 ? ` (${formatCurrency(-projectedRemaining)} over)` : ""}. You can
                      confirm the booking after this.
                    </>
                  )}
                </Alert>
              ) : null}

              {pending ? (
                <Button variant="ghost" size="sm" className="mt-3 h-11 sm:h-9" onClick={() => setManual(false)}>
                  ← Back to reviewing the screenshot
                </Button>
              ) : null}
            </div>
          ) : (
            <>
              {/* Pinned to the attempt being reviewed, not to the newest upload. */}
              <a
                href={`/api/admin/bookings/${booking.id}/screenshot?attempt=${encodeURIComponent(pending.id)}`}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-4 block"
              >
                <Button variant="secondary" size="sm" className="h-11 w-full sm:h-9">
                  <ImageIcon className="h-4 w-4" aria-hidden="true" />
                  Open this screenshot
                  <ExternalLink className="h-3 w-3" aria-hidden="true" />
                </Button>
              </a>

              <div className="mt-4 flex gap-2" role="group" aria-label="Decision">
                <Button
                  size="sm"
                  variant={mode === "ACCEPT" ? "primary" : "secondary"}
                  className="h-11 flex-1 sm:h-9"
                  onClick={() => setMode("ACCEPT")}
                >
                  Money received
                </Button>
                <Button
                  size="sm"
                  variant={mode === "REJECT" ? "danger" : "secondary"}
                  className="h-11 flex-1 sm:h-9"
                  onClick={() => setMode("REJECT")}
                >
                  Not valid
                </Button>
              </div>

              {mode === "ACCEPT" ? (
                <div className="mt-4">
                  <label className="field-label" htmlFor="payment-amount">
                    How much actually arrived?
                  </label>
                  <input
                    id="payment-amount"
                    type="number"
                    min={1}
                    inputMode="numeric"
                    className="field-input"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                  />
                  <p className="mt-1.5 text-xs text-ink-500">Read it off the screenshot — not what the customer says.</p>

                  {amountValid ? (
                    <Alert tone={projectedRemaining > 0 ? "warning" : "success"} className="mt-3">
                      {projectedRemaining > 0 ? (
                        <>
                          Still short by <strong>{formatCurrency(projectedRemaining)}</strong>. The booking stays pending
                          and <strong>keeps its slots</strong> — you can ask for the balance on WhatsApp.
                        </>
                      ) : (
                        <>
                          Paid in full{projectedRemaining < 0 ? ` (${formatCurrency(-projectedRemaining)} over)` : ""}. You
                          can confirm the booking after this.
                        </>
                      )}
                    </Alert>
                  ) : null}
                </div>
              ) : (
                <div className="mt-4">
                  <ReasonPicker
                    key={`reject-${booking.id}-${String(open)}`}
                    id="payment-note"
                    label="What is wrong with it?"
                    options={REJECT_NOTES}
                    value={note}
                    onChange={setNote}
                    placeholder="Noted against this screenshot only"
                  />
                  <Alert tone="info" className="mt-3">
                    This only turns down <strong>this screenshot</strong>. The booking stays pending and the slots stay
                    reserved, so the customer can still pay.
                  </Alert>
                  <Button variant="ghost" size="sm" className="mt-2 h-11 sm:h-9" onClick={() => setManual(true)}>
                    Or record a payment you received another way →
                  </Button>
                </div>
              )}
            </>
          )}

          {error ? (
            <Alert tone="error" className="mt-3">
              {error}
            </Alert>
          ) : null}

          <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Dialog.Close asChild>
              <Button variant="secondary" className="h-11 sm:h-11" disabled={busy}>
                Close
              </Button>
            </Dialog.Close>

            {manual || !pending ? (
              <Button
                className="h-11"
                disabled={busy || !amountValid || note.trim().length < 3}
                onClick={() => onRecord(parsed, note.trim())}
              >
                {busy ? <Spinner /> : null}
                {busy ? "Saving…" : `Record ${amountValid ? formatCurrency(parsed) : "payment"}`}
              </Button>
            ) : (
              <Button
                className="h-11"
                variant={mode === "ACCEPT" ? "primary" : "danger"}
                disabled={busy || (mode === "ACCEPT" ? !amountValid : note.trim().length < 3)}
                onClick={() =>
                  mode === "ACCEPT"
                    ? onAccept(pending.id, parsed, note.trim() || undefined)
                    : onReject(pending.id, note.trim())
                }
              >
                {busy ? <Spinner /> : null}
                {busy ? "Saving…" : mode === "ACCEPT" ? "Record payment" : "Mark not valid"}
              </Button>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
