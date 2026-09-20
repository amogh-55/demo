"use client";

import * as React from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { ArrowLeft, Check, Clock, Copy, ImageUp, MapPin, Trash2 } from "lucide-react";
import { api, errorMessage } from "@/lib/client";
import { formatBusinessDate, formatMinutes, formatRange, minutesToDuration } from "@/lib/time";
import { Alert, Button, EmptyState, Spinner, cn, formatCurrency } from "@/components/ui/primitives";
import type { PublicSlotStatus } from "@/lib/types";

export interface PublicLocation {
  id: string;
  name: string;
  slug: string;
  address: string;
  description: string;
  image: string;
}

export interface PaymentSettings {
  businessName: string;
  upiId: string;
  upiPayeeName: string;
  upiQrImageUrl: string;
  supportPhone: string;
}

interface AvailabilityUnit {
  startMin: number;
  endMin: number;
  price: number;
  status: PublicSlotStatus;
}

interface AvailabilityResponse {
  locationName: string;
  date: string;
  slotMinutes: number;
  holdMinutes: number;
  dayBlocked: boolean;
  units: AvailabilityUnit[];
}

interface HoldResponse {
  holdUntil: string;
  locationId: string;
  locationName: string;
  date: string;
  startMin: number;
  endMin: number;
  amount: number;
  breakdown: Array<{ startMin: number; endMin: number; price: number }>;
}

type Step = "slots" | "details" | "payment";

/** Slow poll while the slot list is on screen. Gentle enough not to hammer the API. */
const AVAILABILITY_REFRESH_MS = 20_000;
/** How long a "slot just taken" notice stays up before clearing itself. */
const CONFLICT_NOTICE_MS = 8_000;

/** Adds days to a "YYYY-MM-DD" business date without touching the browser clock. */
function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + days)).toISOString().slice(0, 10);
}

export function BookingFlow({
  locations,
  payment,
  initialLocationSlug,
  today,
  bookingWindowDays,
}: {
  locations: PublicLocation[];
  payment: PaymentSettings;
  initialLocationSlug?: string;
  /**
   * Today's date in Asia/Kolkata, computed on the server. Deliberately NOT derived
   * from the browser clock: a phone set to the wrong date or another timezone would
   * otherwise default to a day the turf will reject, and computing it during render
   * makes the server and client HTML disagree at hydration.
   */
  today: string;
  bookingWindowDays: number;
}) {
  const router = useRouter();

  const [locationId, setLocationId] = React.useState<string>(
    () => locations.find((l) => l.slug === initialLocationSlug)?.id ?? locations[0]?.id ?? "",
  );
  const [date, setDate] = React.useState<string>(today);

  const [availability, setAvailability] = React.useState<AvailabilityResponse | null>(null);
  const [loadingAvailability, setLoadingAvailability] = React.useState(false);
  const [availabilityError, setAvailabilityError] = React.useState<string | null>(null);

  const [selection, setSelection] = React.useState<{ startMin: number; endMin: number } | null>(null);
  const [step, setStep] = React.useState<Step>("slots");

  const [hold, setHold] = React.useState<HoldResponse | null>(null);
  const [holding, setHolding] = React.useState(false);
  const [holdExpired, setHoldExpired] = React.useState(false);
  const [remaining, setRemaining] = React.useState(0);

  const [name, setName] = React.useState("");
  const [phone, setPhone] = React.useState("");

  const [file, setFile] = React.useState<File | null>(null);
  const [preview, setPreview] = React.useState<string | null>(null);
  const [screenshotKey, setScreenshotKey] = React.useState<string | null>(null);
  const [uploading, setUploading] = React.useState(false);

  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);

  const location = locations.find((l) => l.id === locationId);

  /* ── Availability ──────────────────────────────────────────────────── */

  const loadAvailability = React.useCallback(async ({ silent = false }: { silent?: boolean } = {}) => {
    if (!locationId || !date) return;
    // A background poll must not blank the grid the customer is reading.
    if (!silent) setLoadingAvailability(true);
    setAvailabilityError(null);
    try {
      const data = await api<AvailabilityResponse>(
        `/api/availability?locationId=${encodeURIComponent(locationId)}&date=${encodeURIComponent(date)}`,
      );
      setAvailability(data);
    } catch (err) {
      // A failed background poll leaves the last good list on screen; the hold
      // attempt is re-checked server-side anyway.
      if (!silent) {
        setAvailability(null);
        setAvailabilityError(errorMessage(err));
      }
    } finally {
      if (!silent) setLoadingAvailability(false);
    }
  }, [locationId, date]);

  React.useEffect(() => {
    setSelection(null);
    setError(null);
    void loadAvailability();
  }, [loadAvailability]);

  /**
   * "This slot was just taken" explains a click that did not work. Once the grid
   * behind it has been refreshed the message no longer describes what is on
   * screen, so it clears itself rather than sitting there for good.
   */
  React.useEffect(() => {
    if (!error || step !== "slots") return;
    const id = window.setTimeout(() => setError(null), CONFLICT_NOTICE_MS);
    return () => window.clearTimeout(id);
  }, [error, step]);

  /**
   * A slot list goes stale the moment someone else holds a slot. The atomic hold
   * is what actually prevents a double booking — this only spares the customer
   * from picking a slot that is already gone.
   *
   * Refreshes when the tab or window is brought back, and slowly while it is
   * visible. No socket, and no request at all while the tab is hidden.
   */
  React.useEffect(() => {
    if (step !== "slots") return;

    const refresh = () => {
      if (document.visibilityState === "visible") void loadAvailability({ silent: true });
    };

    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    const poll = window.setInterval(refresh, AVAILABILITY_REFRESH_MS);

    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
      window.clearInterval(poll);
    };
  }, [step, loadAvailability]);

  /* ── Hold recovery after a refresh or a back navigation ────────────── */

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const data = await api<{ hold: (HoldResponse & { submittedBookingReference: string | null }) | null }>(
          "/api/holds",
        );
        if (cancelled || !data.hold) return;
        // A hold that already became a booking is finished business. Resuming it
        // would trap a customer who simply wants to book another slot.
        if (data.hold.submittedBookingReference) return;
        setHold(data.hold);
        setLocationId(data.hold.locationId);
        setDate(data.hold.date);
        setSelection({ startMin: data.hold.startMin, endMin: data.hold.endMin });
        setStep("details");
      } catch {
        // No recoverable hold; the normal flow starts from scratch.
      }
    })();
    return () => {
      cancelled = true;
    };
    // Runs once on mount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ── Hold countdown (display only; the server enforces expiry) ─────── */

  React.useEffect(() => {
    if (!hold) return;
    const tick = () => {
      const ms = new Date(hold.holdUntil).getTime() - Date.now();
      setRemaining(Math.max(0, Math.floor(ms / 1000)));
      if (ms <= 0) setHoldExpired(true);
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [hold]);

  React.useEffect(() => {
    return () => {
      if (preview) URL.revokeObjectURL(preview);
    };
  }, [preview]);

  /* ── Slot selection ────────────────────────────────────────────────── */

  const units = React.useMemo(() => availability?.units ?? [], [availability]);

  const selectableRange = React.useCallback(
    (startMin: number, endMin: number) =>
      units
        .filter((u) => u.startMin >= startMin && u.endMin <= endMin)
        .every((u) => u.status === "AVAILABLE"),
    [units],
  );

  function onSlotClick(unit: AvailabilityUnit) {
    if (unit.status !== "AVAILABLE") return;
    setError(null);

    if (!selection) {
      setSelection({ startMin: unit.startMin, endMin: unit.endMin });
      return;
    }
    if (unit.startMin === selection.startMin && unit.endMin === selection.endMin) {
      setSelection(null);
      return;
    }
    // Extending forwards builds a multi-hour booking; anything else restarts.
    if (unit.endMin > selection.endMin && selectableRange(selection.startMin, unit.endMin)) {
      setSelection({ startMin: selection.startMin, endMin: unit.endMin });
      return;
    }
    setSelection({ startMin: unit.startMin, endMin: unit.endMin });
  }

  const selectedUnits = selection
    ? units.filter((u) => u.startMin >= selection.startMin && u.endMin <= selection.endMin)
    : [];
  const selectedAmount = selectedUnits.reduce((sum, u) => sum + u.price, 0);

  /* ── Actions ───────────────────────────────────────────────────────── */

  async function startHold() {
    if (!selection || holding) return;
    setHolding(true);
    setError(null);
    try {
      const created = await api<HoldResponse>("/api/holds", {
        method: "POST",
        body: JSON.stringify({ locationId, date, startMin: selection.startMin, endMin: selection.endMin }),
      });
      setHold(created);
      setHoldExpired(false);
      setStep("details");
    } catch (err) {
      setError(errorMessage(err));
      // The list we rendered is out of date, and so is the highlighted range.
      setSelection(null);
      void loadAvailability({ silent: true });
    } finally {
      setHolding(false);
    }
  }

  async function releaseAndRestart() {
    try {
      await api("/api/holds", { method: "DELETE" });
    } catch {
      // Releasing is best-effort; the hold expires on its own regardless.
    }
    setHold(null);
    setHoldExpired(false);
    setScreenshotKey(null);
    setFile(null);
    setPreview(null);
    setStep("slots");
    void loadAvailability();
  }

  async function onFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const chosen = event.target.files?.[0];
    event.target.value = ""; // allows re-picking the same file after a failure
    if (!chosen) return;

    setError(null);
    if (!["image/jpeg", "image/png", "image/webp"].includes(chosen.type)) {
      setError("Please upload a JPG, PNG or WebP screenshot.");
      return;
    }
    if (chosen.size > 5 * 1024 * 1024) {
      setError("That image is larger than 5MB. Please upload a smaller screenshot.");
      return;
    }

    if (preview) URL.revokeObjectURL(preview);
    setFile(chosen);
    setPreview(URL.createObjectURL(chosen));
    setScreenshotKey(null);

    setUploading(true);
    try {
      const form = new FormData();
      form.append("file", chosen);
      const result = await api<{ key: string }>("/api/uploads", { method: "POST", body: form });
      setScreenshotKey(result.key);
    } catch (err) {
      setScreenshotKey(null);
      setError(errorMessage(err));
    } finally {
      setUploading(false);
    }
  }

  function clearFile() {
    if (preview) URL.revokeObjectURL(preview);
    setFile(null);
    setPreview(null);
    setScreenshotKey(null);
  }

  async function submitBooking() {
    if (submitting || !screenshotKey) return;
    setSubmitting(true);
    setError(null);
    try {
      await api("/api/bookings", {
        method: "POST",
        body: JSON.stringify({ customerName: name, customerPhone: phone, paymentScreenshotKey: screenshotKey }),
      });
      router.push("/booking/success");
    } catch (err) {
      setError(errorMessage(err));
      setSubmitting(false);
    }
  }

  const detailsValid = name.trim().length >= 2 && /^[6-9]\d{9}$/.test(phone.replace(/\D/g, "").slice(-10));

  /* ── Render ────────────────────────────────────────────────────────── */

  if (locations.length === 0) {
    return <EmptyState title="No active locations" hint="Bookings are closed right now. Please check back shortly." />;
  }

  return (
    <div className="space-y-6">
      {holdExpired && step !== "slots" ? (
        <section className="card text-center" aria-live="assertive">
          <span className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-amber-100 text-amber-700">
            <Clock className="h-6 w-6" aria-hidden="true" />
          </span>
          <h2 className="mt-3 text-lg font-semibold text-white">Your slot hold has expired</h2>
          <p className="mx-auto mt-2 max-w-sm text-sm text-ink-400">
            Slots are only held for a few minutes so nobody is left waiting. Nothing has been
            booked and you have not been charged. The slot may still be free — pick it again to
            carry on.
          </p>
          <Button size="lg" className="mt-5 w-full sm:w-auto" onClick={releaseAndRestart}>
            Choose a slot again
          </Button>
        </section>
      ) : null}

      {step === "slots" ? (
        <>
          {/* Location */}
          <section aria-labelledby="location-heading" className="card">
            <h2 id="location-heading" className="text-lg font-semibold text-white">
              1. Choose a ground
            </h2>
            <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {locations.map((l) => {
                const active = l.id === locationId;
                return (
                  <button
                    key={l.id}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setLocationId(l.id)}
                    className={cn(
                      "flex gap-3 rounded-lg border p-3 text-left transition-colors",
                      active ? "border-lime-400 bg-lime-400/10 ring-1 ring-lime-400" : "border-white/10 hover:bg-white/5",
                    )}
                  >
                    <span className="relative h-14 w-14 shrink-0 overflow-hidden rounded-md bg-white/10">
                      <Image src={l.image || "/images/box-cricket-turf.jpg"} alt="" fill sizes="56px" className="object-cover" />
                    </span>
                    <span className="min-w-0">
                      <span className="flex items-center gap-1.5 break-words font-semibold text-white">
                        {l.name}
                        {active ? <Check className="h-4 w-4 shrink-0 text-lime-400" aria-hidden="true" /> : null}
                      </span>
                      <span className="mt-0.5 flex items-start gap-1 break-words text-xs text-ink-400">
                        <MapPin className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
                        {l.address}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </section>

          {/* Date */}
          <section aria-labelledby="date-heading" className="card">
            <h2 id="date-heading" className="text-lg font-semibold text-white">
              2. Pick a date
            </h2>
            <div className="mt-4 max-w-xs">
              <label className="field-label" htmlFor="booking-date">
                Match date
              </label>
              <input
                id="booking-date"
                type="date"
                className="field-input"
                value={date}
                min={today}
                max={addDays(today, bookingWindowDays)}
                // Clearing the field would leave the grid showing another day's slots.
                onChange={(e) => setDate(e.target.value || today)}
              />
              <p className="mt-1.5 text-xs text-ink-400">{formatBusinessDate(date)} · times shown in IST</p>
            </div>
          </section>

          {/* Slots */}
          <section aria-labelledby="slots-heading" className="card">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <h2 id="slots-heading" className="text-lg font-semibold text-white">
                  3. Choose your time
                </h2>
                {/* Named again here: the ground cards scroll out of view on a phone,
                    and picking a slot at the wrong ground is an easy mistake. */}
                {location ? (
                  <p className="mt-0.5 flex items-center gap-1.5 break-words text-sm font-medium text-lime-400">
                    <MapPin className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    {location.name}
                  </p>
                ) : null}
              </div>
              <Button
                variant="ghost"
                disabled={loadingAvailability}
                onClick={() => {
                  setError(null);
                  void loadAvailability();
                }}
              >
                Refresh
              </Button>
            </div>

            {loadingAvailability ? (
              <p className="mt-6 flex items-center gap-2 text-sm text-ink-400">
                <Spinner /> Checking availability…
              </p>
            ) : availabilityError ? (
              <Alert tone="error" className="mt-4">
                {availabilityError}
              </Alert>
            ) : availability?.dayBlocked ? (
              <EmptyState title="This ground is closed on the selected date." hint="Please pick another date or another ground." />
            ) : units.length === 0 ? (
              <EmptyState title="No slots available for this date." hint="Try another date or another ground." />
            ) : (
              <>
                <p className="mt-2 text-sm text-ink-400">
                  Tap a slot to start, then tap a later slot to extend. Prices are per hour.
                </p>
                <ul className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
                  {units.map((unit) => {
                    const selected =
                      selection && unit.startMin >= selection.startMin && unit.endMin <= selection.endMin;
                    const available = unit.status === "AVAILABLE";
                    return (
                      <li key={unit.startMin}>
                        <button
                          type="button"
                          disabled={!available}
                          aria-pressed={Boolean(selected)}
                          onClick={() => onSlotClick(unit)}
                          className={cn(
                            "w-full rounded-lg border px-3 py-3 text-left transition-colors",
                            selected
                              ? "border-lime-400 bg-lime-400 text-ink-950"
                              : available
                                ? "border-white/15 bg-white/[0.06] text-white hover:border-lime-400/60 hover:bg-white/10"
                                : "cursor-not-allowed border-white/5 bg-white/[0.02] text-ink-500",
                          )}
                        >
                          {/* The time is the thing being chosen, so it reads at full size. */}
                          <span className="block whitespace-nowrap text-base font-semibold">
                            {formatMinutes(unit.startMin)}
                          </span>
                          <span className={cn("block text-sm", selected ? "text-ink-950/70" : "text-ink-300")}>
                            {available || selected ? formatCurrency(unit.price) : statusLabel(unit.status)}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </>
            )}

            {selection ? (
              <div className="mt-6 rounded-lg border border-lime-400/30 bg-lime-400/10 p-4">
                {/* Stacked on a phone so Continue is a full-width thumb target under the
                    slot it confirms, rather than a small button pushed to one side. */}
                <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <p className="font-semibold text-white">{formatRange(selection.startMin, selection.endMin)}</p>
                    <p className="text-sm text-ink-400">
                      {minutesToDuration(selection.endMin - selection.startMin)} · {formatCurrency(selectedAmount)}
                    </p>
                  </div>
                  <Button size="lg" className="w-full sm:w-auto" onClick={startHold} disabled={holding}>
                    {holding ? <Spinner /> : null}
                    {holding ? "Holding your slot…" : "Continue"}
                  </Button>
                </div>
              </div>
            ) : null}

            {error ? (
              <Alert tone="error" className="mt-4">
                {error}
              </Alert>
            ) : null}
          </section>
        </>
      ) : null}

      {step !== "slots" && hold && !holdExpired ? (
        <>
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-lg border border-amber-400/30 bg-amber-400/10 px-4 py-2">
            <p className="flex items-center gap-2 text-sm font-medium text-amber-100">
              <Clock className="h-4 w-4 shrink-0" aria-hidden="true" />
              Slot held for{" "}
              <span aria-live="polite" className="tabular-nums font-semibold">
                {String(Math.floor(remaining / 60)).padStart(2, "0")}:{String(remaining % 60).padStart(2, "0")}
              </span>
            </p>
            <Button variant="ghost" onClick={releaseAndRestart}>
              <ArrowLeft className="h-4 w-4" aria-hidden="true" />
              Change slot
            </Button>
          </div>

          <section className="card" aria-labelledby="summary-heading">
            <h2 id="summary-heading" className="text-lg font-semibold text-white">
              Booking summary
            </h2>
            <dl className="mt-4 divide-y divide-white/10 text-sm">
              <Row label="Ground" value={hold.locationName} />
              <Row label="Address" value={location?.address ?? "—"} />
              <Row label="Date" value={formatBusinessDate(hold.date)} />
              <Row label="Time" value={formatRange(hold.startMin, hold.endMin)} />
              <Row label="Duration" value={minutesToDuration(hold.endMin - hold.startMin)} />
              <Row label="Amount" value={formatCurrency(hold.amount)} strong />
            </dl>
          </section>

          {step === "details" ? (
            <section className="card" aria-labelledby="details-heading">
              <h2 id="details-heading" className="text-lg font-semibold text-white">
                Your details
              </h2>
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <div>
                  <label className="field-label" htmlFor="customer-name">
                    Full name
                  </label>
                  <input
                    id="customer-name"
                    className="field-input"
                    autoComplete="name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Your name"
                    required
                  />
                </div>
                <div>
                  <label className="field-label" htmlFor="customer-phone">
                    Mobile number
                  </label>
                  <input
                    id="customer-phone"
                    className="field-input"
                    type="tel"
                    inputMode="numeric"
                    autoComplete="tel"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder="10-digit mobile number"
                    required
                  />
                  <p className="mt-1.5 text-xs text-ink-400">We will confirm your booking on WhatsApp.</p>
                </div>
              </div>
              <Button
                size="lg"
                className="mt-5 w-full sm:w-auto"
                disabled={!detailsValid || holdExpired}
                onClick={() => setStep("payment")}
              >
                Continue to payment
              </Button>
            </section>
          ) : null}

          {step === "payment" ? (
            <>
              <section className="card" aria-labelledby="payment-heading">
                <h2 id="payment-heading" className="text-lg font-semibold text-white">
                  Pay {formatCurrency(hold.amount)} by UPI
                </h2>
                <p className="mt-1 text-sm text-ink-400">
                  Pay using any UPI app, then upload the payment screenshot below.
                </p>

                <div className="mt-4 grid gap-5 sm:grid-cols-[auto,1fr] sm:items-start">
                  {payment.upiQrImageUrl ? (
                    <Image
                      src={payment.upiQrImageUrl}
                      alt="UPI QR code"
                      width={200}
                      height={200}
                      className="mx-auto rounded-lg border border-white/10 bg-white p-2"
                      unoptimized
                    />
                  ) : (
                    <div className="mx-auto grid h-[200px] w-[200px] place-items-center rounded-lg border border-dashed border-white/10 text-center text-xs text-ink-400">
                      QR code not configured.
                      <br />
                      Use the UPI ID below.
                    </div>
                  )}

                  <dl className="space-y-3 text-sm">
                    <div>
                      <dt className="text-ink-400">UPI ID</dt>
                      {/* A UPI id is one unbreakable word wider than a 320px phone, so it
                          gets its own line to wrap in rather than squeezing Copy off screen. */}
                      <dd className="mt-1 flex flex-wrap items-center gap-2">
                        <code className="min-w-0 break-words rounded bg-white/10 px-2 py-1 font-semibold text-white">
                          {payment.upiId || "—"}
                        </code>
                        {payment.upiId ? (
                          <Button
                            variant="secondary"
                            onClick={() => {
                              void navigator.clipboard?.writeText(payment.upiId);
                              setCopied(true);
                              window.setTimeout(() => setCopied(false), 1500);
                            }}
                          >
                            <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                            {copied ? "Copied" : "Copy"}
                          </Button>
                        ) : null}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-ink-400">Payee name</dt>
                      <dd className="mt-1 break-words font-medium text-white">
                        {payment.upiPayeeName || payment.businessName}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-ink-400">Amount to pay</dt>
                      <dd className="mt-1 text-lg font-bold text-white">{formatCurrency(hold.amount)}</dd>
                    </div>
                  </dl>
                </div>
              </section>

              <section className="card" aria-labelledby="upload-heading">
                <h2 id="upload-heading" className="text-lg font-semibold text-white">
                  Upload payment screenshot
                </h2>
                <p className="mt-1 text-sm text-ink-400">JPG, PNG or WebP · up to 5MB</p>

                {!file ? (
                  <label className="mt-4 flex cursor-pointer flex-col items-center gap-2 rounded-lg border border-dashed border-white/15 px-6 py-8 text-center hover:bg-white/5">
                    <ImageUp className="h-6 w-6 text-ink-400" aria-hidden="true" />
                    <span className="text-sm font-medium text-ink-100">Choose screenshot</span>
                    <span className="text-xs text-ink-400">Take a photo or pick from your gallery</span>
                    <input type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" onChange={onFileChange} />
                  </label>
                ) : (
                  <div className="mt-4 flex items-start gap-4">
                    {preview ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={preview} alt="Payment screenshot preview" className="h-28 w-24 rounded-lg border border-white/10 object-cover" />
                    ) : null}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-ink-200">{file.name}</p>
                      <p className="mt-0.5 text-xs text-ink-400">{(file.size / 1024).toFixed(0)} KB</p>
                      <p className="mt-2 text-sm">
                        {uploading ? (
                          <span className="flex items-center gap-2 text-ink-400">
                            <Spinner /> Uploading…
                          </span>
                        ) : screenshotKey ? (
                          <span className="flex items-center gap-1.5 font-medium text-lime-400">
                            <Check className="h-4 w-4" aria-hidden="true" /> Uploaded
                          </span>
                        ) : (
                          <span className="text-red-300">Upload failed. Choose the file again.</span>
                        )}
                      </p>
                      <Button variant="ghost" className="mt-2 -ml-4" onClick={clearFile} disabled={uploading}>
                        <Trash2 className="h-4 w-4" aria-hidden="true" />
                        Remove
                      </Button>
                    </div>
                  </div>
                )}
              </section>

              <section className="card" aria-labelledby="confirm-heading">
                <h2 id="confirm-heading" className="text-lg font-semibold text-white">
                  Confirm your request
                </h2>
                <dl className="mt-4 divide-y divide-white/10 text-sm">
                  <Row label="Name" value={name} />
                  <Row label="Mobile" value={phone} />
                  <Row label="Ground" value={hold.locationName} />
                  <Row label="Date" value={formatBusinessDate(hold.date)} />
                  <Row label="Time" value={formatRange(hold.startMin, hold.endMin)} />
                  <Row label="Amount paid" value={formatCurrency(hold.amount)} strong />
                </dl>

                <Alert tone="info" className="mt-4">
                  Your booking will be confirmed after the turf team verifies your payment.
                </Alert>

                {error ? (
                  <Alert tone="error" className="mt-3">
                    {error}
                  </Alert>
                ) : null}

                <Button
                  className="mt-4 w-full"
                  size="lg"
                  disabled={!screenshotKey || uploading || submitting || holdExpired}
                  onClick={submitBooking}
                >
                  {submitting ? <Spinner /> : null}
                  {submitting ? "Submitting…" : "Book now"}
                </Button>
              </section>
            </>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    // A ground name or address is the long half of the row, so the label holds its
    // width and the value gets everything else to wrap in.
    <div className="flex justify-between gap-3 py-2">
      <dt className="shrink-0 text-ink-400">{label}</dt>
      <dd
        className={cn(
          "min-w-0 break-words text-right",
          strong ? "text-base font-bold text-white" : "font-medium text-ink-200",
        )}
      >
        {value}
      </dd>
    </div>
  );
}

function statusLabel(status: PublicSlotStatus): string {
  switch (status) {
    case "BOOKED":
      return "Booked";
    case "PENDING":
      return "On hold";
    case "HELD":
      return "On hold";
    case "BLOCKED":
      return "Ground closed";
    case "PAST":
      return "Passed";
    default:
      return "Unavailable";
  }
}
