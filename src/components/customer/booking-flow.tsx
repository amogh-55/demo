"use client";

import * as React from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { ArrowLeft, Check, Clock, Copy, ImageUp, MapPin, Navigation, ShieldCheck, Trash2 } from "lucide-react";
import { api, errorMessage } from "@/lib/client";
import { runIsFree } from "@/lib/booking/schedule";
import { facilityPhoto } from "@/lib/photos";
import { formatBusinessDate, formatCompactRange, formatRange, minutesToDuration } from "@/lib/time";
import { Alert, Button, EmptyState, Spinner, cn, formatCurrency } from "@/components/ui/primitives";
import type { FacilityKind, PublicSlotStatus } from "@/lib/types";

export interface PublicResource {
  id: string;
  name: string;
  slug: string;
}

export interface PublicFacility {
  id: string;
  name: string;
  slug: string;
  kind: FacilityKind;
  description: string;
  resources: PublicResource[];
  fromPrice: number | null;
  fromPricePerBlock: number | null;
  oversPerSlot: number;
  slotMinutes: number;
}

export interface PublicLocation {
  id: string;
  name: string;
  slug: string;
  address: string;
  mapsUrl: string;
  description: string;
  image: string;
  facilities: PublicFacility[];
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
  resourceId: string;
  resourceName: string;
  facilityName: string;
  facilityKind: FacilityKind;
  locationName: string;
  date: string;
  slotMinutes: number;
  holdMinutes: number;
  dayBlocked: boolean;
  units: AvailabilityUnit[];
  oversPerSlot: number;
  oversLadder: number[];
  payAtVenueMaxOvers: number;
  ballTypes: Array<{ id: string; name: string; pricePerSlot: number }>;
}

interface HoldResponse {
  holdUntil: string;
  resourceId: string;
  resourceName: string;
  facilityName: string;
  facilityKind: FacilityKind;
  locationId: string;
  locationName: string;
  date: string;
  startMin: number;
  endMin: number;
  overs: number | null;
  ballTypeName: string | null;
  payAtVenue: boolean;
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

const normalisePhone = (raw: string) => raw.replace(/\D/g, "").slice(-10);
const phoneLooksValid = (raw: string) => /^[6-9]\d{9}$/.test(normalisePhone(raw));

export function BookingFlow({
  locations,
  payment,
  initialLocationSlug,
  today,
  bookingWindowDays,
  otpEnabled,
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
  /**
   * Whether customers must verify their mobile number. Mirrors the admin switch;
   * the server checks it again on submission, so a stale page cannot skip it.
   */
  otpEnabled: boolean;
}) {
  const router = useRouter();

  const initialLocation = locations.find((l) => l.slug === initialLocationSlug) ?? locations[0];
  const [locationId, setLocationId] = React.useState<string>(() => initialLocation?.id ?? "");
  const [facilityId, setFacilityId] = React.useState<string>(() => initialLocation?.facilities[0]?.id ?? "");
  const [resourceId, setResourceId] = React.useState<string>(
    () => initialLocation?.facilities[0]?.resources[0]?.id ?? "",
  );
  const [date, setDate] = React.useState<string>(today);

  const [availability, setAvailability] = React.useState<AvailabilityResponse | null>(null);
  const [loadingAvailability, setLoadingAvailability] = React.useState(false);
  const [availabilityError, setAvailabilityError] = React.useState<string | null>(null);

  const [selection, setSelection] = React.useState<{ startMin: number; endMin: number } | null>(null);
  const [overs, setOvers] = React.useState<number | null>(null);
  const [ballTypeId, setBallTypeId] = React.useState<string | null>(null);
  const [step, setStep] = React.useState<Step>("slots");

  const [hold, setHold] = React.useState<HoldResponse | null>(null);
  const [holding, setHolding] = React.useState(false);
  const [holdExpired, setHoldExpired] = React.useState(false);
  const [remaining, setRemaining] = React.useState(0);

  const [name, setName] = React.useState("");
  const [phone, setPhone] = React.useState("");

  const [otpSent, setOtpSent] = React.useState(false);
  const [otpCode, setOtpCode] = React.useState("");
  const [otpBusy, setOtpBusy] = React.useState(false);
  const [otpError, setOtpError] = React.useState<string | null>(null);
  const [otpNotice, setOtpNotice] = React.useState<string | null>(null);
  const [resendIn, setResendIn] = React.useState(0);
  /** The exact number that was verified, so editing a digit invalidates it. */
  const [verifiedPhone, setVerifiedPhone] = React.useState<string | null>(null);

  const [file, setFile] = React.useState<File | null>(null);
  const [preview, setPreview] = React.useState<string | null>(null);
  const [screenshotKey, setScreenshotKey] = React.useState<string | null>(null);
  const [uploading, setUploading] = React.useState(false);

  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);

  const location = locations.find((l) => l.id === locationId);
  const facility = location?.facilities.find((f) => f.id === facilityId);
  const isOvers = facility?.kind === "OVERS";

  /* ── Keeping the location → facility → court chain valid ───────────── */

  React.useEffect(() => {
    if (!location) return;
    if (location.facilities.some((f) => f.id === facilityId)) return;
    setFacilityId(location.facilities[0]?.id ?? "");
  }, [location, facilityId]);

  React.useEffect(() => {
    if (!facility) return;
    if (facility.resources.some((r) => r.id === resourceId)) return;
    setResourceId(facility.resources[0]?.id ?? "");
  }, [facility, resourceId]);

  /* ── Availability ──────────────────────────────────────────────────── */

  const loadAvailability = React.useCallback(async ({ silent = false }: { silent?: boolean } = {}) => {
    if (!resourceId || !date) return;
    // A background poll must not blank the grid the customer is reading.
    if (!silent) setLoadingAvailability(true);
    setAvailabilityError(null);
    try {
      const data = await api<AvailabilityResponse>(
        `/api/availability?resourceId=${encodeURIComponent(resourceId)}&date=${encodeURIComponent(date)}`,
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
  }, [resourceId, date]);

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

  /** Default the ball to the first on offer so a price is always on screen. */
  React.useEffect(() => {
    if (!availability || availability.facilityKind !== "OVERS") return;
    setBallTypeId((current) =>
      current && availability.ballTypes.some((b) => b.id === current) ? current : availability.ballTypes[0]?.id ?? null,
    );
    setOvers((current) => current ?? availability.oversLadder[0] ?? null);
  }, [availability]);

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
        setResourceId(data.hold.resourceId);
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
    if (resendIn <= 0) return;
    const id = window.setInterval(() => setResendIn((s) => Math.max(0, s - 1)), 1000);
    return () => window.clearInterval(id);
  }, [resendIn]);

  React.useEffect(() => {
    return () => {
      if (preview) URL.revokeObjectURL(preview);
    };
  }, [preview]);

  /* ── Slot selection ────────────────────────────────────────────────── */

  const units = React.useMemo(() => availability?.units ?? [], [availability]);

  const freeStarts = React.useMemo(
    () => new Set(units.filter((u) => u.status === "AVAILABLE").map((u) => u.startMin)),
    [units],
  );

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

  const ball = availability?.ballTypes.find((b) => b.id === ballTypeId) ?? null;

  /** How many consecutive slots the chosen overs need, and what they cost. */
  const sessionSlots =
    availability && availability.oversPerSlot > 0 && overs ? Math.round(overs / availability.oversPerSlot) : 0;
  const sessionMinutes = availability ? sessionSlots * availability.slotMinutes : 0;
  const sessionPrice = ball ? ball.pricePerSlot * sessionSlots : 0;
  /** Whole blocks only — there is no fraction of a slot to reserve. */
  const oversValid =
    Boolean(availability && availability.oversPerSlot > 0 && overs && overs % availability.oversPerSlot === 0);
  const payAtVenue = Boolean(
    availability && overs && availability.payAtVenueMaxOvers > 0 && overs <= availability.payAtVenueMaxOvers,
  );

  /**
   * A bowling session runs over consecutive quarter-hours, so a start time only
   * works if every quarter the chosen overs need is free. Offering one that is
   * not just moves the refusal to the payment screen.
   */
  const fitsAt = React.useCallback(
    (startMin: number) => {
      if (!availability || sessionSlots <= 0) return false;
      return runIsFree(availability.slotMinutes, freeStarts, startMin, sessionSlots);
    },
    [availability, sessionSlots, freeStarts],
  );

  const anyStartFits = React.useMemo(
    () => units.some((u) => u.status === "AVAILABLE" && fitsAt(u.startMin)),
    [units, fitsAt],
  );

  const selectedUnits = selection
    ? units.filter((u) => u.startMin >= selection.startMin && u.endMin <= selection.endMin)
    : [];
  const selectedAmount = isOvers ? sessionPrice : selectedUnits.reduce((sum, u) => sum + u.price, 0);

  const readyToHold = isOvers ? Boolean(selection && ball && oversValid && sessionSlots > 0) : Boolean(selection);

  /* ── Actions ───────────────────────────────────────────────────────── */

  async function startHold() {
    if (!selection || holding || !readyToHold) return;
    setHolding(true);
    setError(null);
    try {
      const created = await api<HoldResponse>("/api/holds", {
        method: "POST",
        body: JSON.stringify(
          isOvers
            ? { resourceId, date, startMin: selection.startMin, overs, ballTypeId }
            : { resourceId, date, startMin: selection.startMin, endMin: selection.endMin },
        ),
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

  async function sendCode() {
    if (otpBusy || !phoneLooksValid(phone)) return;
    setOtpBusy(true);
    setOtpError(null);
    setOtpNotice(null);
    try {
      const result = await api<{ resendAfterSeconds: number; delivered: boolean }>("/api/otp/send", {
        method: "POST",
        body: JSON.stringify({ phone }),
      });
      setOtpSent(true);
      setResendIn(result.resendAfterSeconds);
      setOtpNotice(
        result.delivered
          ? `Code sent to ${normalisePhone(phone)}.`
          : "We could not send the code right now. Please call the ground to book.",
      );
    } catch (err) {
      setOtpError(errorMessage(err));
    } finally {
      setOtpBusy(false);
    }
  }

  async function checkCode() {
    if (otpBusy || otpCode.trim().length !== 6) return;
    setOtpBusy(true);
    setOtpError(null);
    try {
      await api("/api/otp/verify", { method: "POST", body: JSON.stringify({ phone, code: otpCode.trim() }) });
      setVerifiedPhone(normalisePhone(phone));
      setOtpNotice(null);
      setOtpCode("");
    } catch (err) {
      setOtpError(errorMessage(err));
    } finally {
      setOtpBusy(false);
    }
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
    // A pay-at-the-ground session has no screenshot to wait for; every other
    // booking still does. The server decides which it is regardless of this.
    if (submitting || (!screenshotKey && !hold?.payAtVenue)) return;
    setSubmitting(true);
    setError(null);
    try {
      await api("/api/bookings", {
        method: "POST",
        body: JSON.stringify({
          customerName: name,
          customerPhone: phone,
          paymentScreenshotKey: screenshotKey,
        }),
      });
      router.push("/booking/success");
    } catch (err) {
      setError(errorMessage(err));
      setSubmitting(false);
    }
  }

  const phoneVerified = !otpEnabled || verifiedPhone === normalisePhone(phone);
  const detailsValid = name.trim().length >= 2 && phoneLooksValid(phone) && phoneVerified;

  /* ── Render ────────────────────────────────────────────────────────── */

  if (locations.length === 0) {
    return <EmptyState title="Nothing is open for booking" hint="Bookings are closed right now. Please check back shortly." />;
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

            {location?.mapsUrl || location?.address ? (
              <a
                href={
                  location.mapsUrl ||
                  `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${location.name} ${location.address}`)}`
                }
                target="_blank"
                rel="noopener noreferrer"
                className="mt-3 inline-flex min-h-[44px] items-center gap-1.5 text-sm font-medium text-lime-400 hover:underline"
              >
                <Navigation className="h-4 w-4" aria-hidden="true" />
                Open {location.name} in Google Maps
              </a>
            ) : null}
          </section>

          {/* Facility — what this ground sells. Grounds differ, so this is never skipped. */}
          <section aria-labelledby="facility-heading" className="card">
            <h2 id="facility-heading" className="text-lg font-semibold text-white">
              2. What would you like to book?
            </h2>
            {!location || location.facilities.length === 0 ? (
              <EmptyState title="Nothing bookable here yet." hint="Please choose another ground." />
            ) : (
              <ul className="mt-4 grid gap-3 sm:grid-cols-2">
                {location.facilities.map((f) => {
                  const active = f.id === facilityId;
                  return (
                    <li key={f.id}>
                      <button
                        type="button"
                        aria-pressed={active}
                        onClick={() => setFacilityId(f.id)}
                        className={cn(
                          "flex w-full flex-col rounded-lg border p-3 text-left transition-colors",
                          active
                            ? "border-lime-400 bg-lime-400/10 ring-1 ring-lime-400"
                            : "border-white/10 hover:bg-white/5",
                        )}
                      >
                        {/* A picture of the thing itself: "Bowling Machine" means
                            nothing to a customer who has not been here before. */}
                        <span className="relative mb-3 block h-24 w-full overflow-hidden rounded-md bg-ink-900">
                          <Image
                            src={facilityPhoto(f.slug)}
                            alt=""
                            fill
                            sizes="(max-width: 640px) 100vw, 50vw"
                            className="object-cover"
                          />
                        </span>
                        <span className="flex items-center gap-1.5 break-words font-semibold text-white">
                          {f.name}
                          {active ? <Check className="h-4 w-4 shrink-0 text-lime-400" aria-hidden="true" /> : null}
                        </span>
                        <span className="mt-0.5 text-xs text-ink-400">
                          {f.kind === "OVERS"
                            ? f.fromPricePerBlock !== null
                              ? `By the over · from ${formatCurrency(f.fromPricePerBlock)} / ${f.oversPerSlot} overs`
                              : "By the over"
                            : f.fromPrice !== null
                              ? `By the hour · from ${formatCurrency(f.fromPrice)}`
                              : "By the hour"}
                        </span>
                        {f.description ? (
                          <span className="mt-1 break-words text-xs text-ink-400">{f.description}</span>
                        ) : null}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}

            {/* Courts. Shown only when there is a real choice — a facility with one
                machine should not ask the customer to pick it. */}
            {facility && facility.resources.length > 1 ? (
              <div className="mt-4">
                <p className="field-label">Which one?</p>
                <ul className="mt-2 flex flex-wrap gap-2">
                  {facility.resources.map((r) => {
                    const active = r.id === resourceId;
                    return (
                      <li key={r.id}>
                        <button
                          type="button"
                          aria-pressed={active}
                          onClick={() => setResourceId(r.id)}
                          className={cn(
                            "min-h-[44px] rounded-lg border px-4 text-sm font-medium transition-colors",
                            active
                              ? "border-lime-400 bg-lime-400 text-ink-950"
                              : "border-white/15 bg-white/[0.06] text-white hover:border-lime-400/60",
                          )}
                        >
                          {r.name}
                        </button>
                      </li>
                    );
                  })}
                </ul>
                <p className="mt-1.5 text-xs text-ink-400">
                  Each one is booked separately — if this one is taken, the other may still be free.
                </p>
              </div>
            ) : null}
          </section>

          {/* Date */}
          <section aria-labelledby="date-heading" className="card">
            <h2 id="date-heading" className="text-lg font-semibold text-white">
              3. Pick a date
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
                  4. {isOvers ? "Choose your session" : "Choose your time"}
                </h2>
                {/* Named again here: the cards above scroll out of view on a phone,
                    and booking the wrong thing at the wrong ground is an easy mistake. */}
                {location && facility ? (
                  <p className="mt-0.5 flex items-center gap-1.5 break-words text-sm font-medium text-lime-400">
                    <MapPin className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    {facility.name}
                    {facility.resources.length > 1
                      ? ` · ${facility.resources.find((r) => r.id === resourceId)?.name ?? ""}`
                      : ""}
                    {` · ${location.name}`}
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
              <EmptyState title="This is closed on the selected date." hint="Please pick another date or another ground." />
            ) : units.length === 0 ? (
              <EmptyState title="No slots available for this date." hint="Try another date or another ground." />
            ) : isOvers && availability ? (
              <>
                {/* Ball first: it sets the price, and a customer choosing overs
                    without seeing what they cost has to work backwards. */}
                <div className="mt-4">
                  <p className="field-label">Ball type</p>
                  <ul className="mt-2 flex flex-wrap gap-2">
                    {availability.ballTypes.map((b) => {
                      const active = b.id === ballTypeId;
                      return (
                        <li key={b.id}>
                          <button
                            type="button"
                            aria-pressed={active}
                            onClick={() => setBallTypeId(b.id)}
                            className={cn(
                              "min-h-[44px] rounded-lg border px-4 text-sm font-medium transition-colors",
                              active
                                ? "border-lime-400 bg-lime-400 text-ink-950"
                                : "border-white/15 bg-white/[0.06] text-white hover:border-lime-400/60",
                            )}
                          >
                            {b.name} · {formatCurrency(b.pricePerSlot)} / {availability.oversPerSlot} overs
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>

                <div className="mt-4">
                  <p className="field-label">How many overs?</p>
                  {/* Quick picks, then a stepper for anything bigger. There is no
                      ceiling — 70, 100, whatever fits before closing time. */}
                  <ul className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
                    {availability.oversLadder.slice(0, 4).map((value) => {
                      const active = value === overs;
                      const slots = value / availability.oversPerSlot;
                      return (
                        <li key={value}>
                          <button
                            type="button"
                            aria-pressed={active}
                            onClick={() => {
                              setOvers(value);
                              setSelection(null);
                            }}
                            className={cn(
                              "w-full rounded-lg border px-3 py-3 text-left transition-colors",
                              active
                                ? "border-lime-400 bg-lime-400 text-ink-950"
                                : "border-white/15 bg-white/[0.06] text-white hover:border-lime-400/60",
                            )}
                          >
                            <span className="block text-base font-semibold">{value} overs</span>
                            <span className={cn("block text-sm", active ? "text-ink-950/70" : "text-ink-300")}>
                              {minutesToDuration(slots * availability.slotMinutes)}
                              {ball ? ` · ${formatCurrency(ball.pricePerSlot * slots)}` : ""}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>

                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <span className="text-sm text-ink-400">Want more?</span>
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        aria-label={`Fewer overs`}
                        disabled={!overs || overs <= availability.oversPerSlot}
                        onClick={() => {
                          setOvers((o) => Math.max(availability.oversPerSlot, (o ?? 0) - availability.oversPerSlot));
                          setSelection(null);
                        }}
                        className="h-11 w-11 rounded-lg border border-white/15 bg-white/[0.06] text-lg font-semibold text-white disabled:opacity-40"
                      >
                        −
                      </button>
                      <span className="min-w-[5.5rem] text-center text-base font-semibold tabular-nums text-white">
                        {overs ?? 0} overs
                      </span>
                      <button
                        type="button"
                        aria-label={`More overs`}
                        onClick={() => {
                          setOvers((o) => (o ?? 0) + availability.oversPerSlot);
                          setSelection(null);
                        }}
                        className="h-11 w-11 rounded-lg border border-white/15 bg-white/[0.06] text-lg font-semibold text-white"
                      >
                        +
                      </button>
                    </div>
                    {ball ? (
                      <span className="text-sm font-semibold text-lime-400">
                        {formatCurrency(sessionPrice)} · {minutesToDuration(sessionMinutes)}
                      </span>
                    ) : null}
                  </div>

                  {/* Said here, before the slot is picked, because it changes what
                      the rest of the flow will ask them to do. */}
                  {availability.payAtVenueMaxOvers > 0 ? (
                    <Alert tone={payAtVenue ? "success" : "info"} className="mt-3">
                      {payAtVenue
                        ? `Up to ${availability.payAtVenueMaxOvers} overs is confirmed straight away — no online payment. Pay ${formatCurrency(sessionPrice)} at the ground.`
                        : `Over ${availability.payAtVenueMaxOvers} overs we ask for payment online before confirming.`}
                    </Alert>
                  ) : null}
                </div>

                {/* Every quarter-hour of the day, not just the free ones: seeing
                    that 7:00 is already taken is how a customer decides what to
                    do instead. Each button is ONE block and shows only its own
                    clock time — printing the whole session on every button made
                    neighbouring buttons read as overlapping bookings. Picking one
                    lights up the run of blocks the chosen overs need. */}
                <div className="mt-5">
                  <p className="field-label">Pick a start time</p>
                  <p className="mt-0.5 text-sm text-ink-400">
                    Each slot is {availability.oversPerSlot} overs ({minutesToDuration(availability.slotMinutes)}).
                    {sessionSlots > 1
                      ? ` ${overs} overs takes ${sessionSlots} slots in a row — tap the first one.`
                      : " Tap the one you want."}
                  </p>

                  {!anyStartFits ? (
                    <EmptyState
                      title="No free run that long on this date."
                      hint="Try fewer overs, another date or another ground."
                    />
                  ) : (
                    <ul className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
                      {units.map((unit) => {
                        const inSelection =
                          selection && unit.startMin >= selection.startMin && unit.startMin < selection.endMin;
                        const free = unit.status === "AVAILABLE";
                        const fits = free && fitsAt(unit.startMin);
                        const runsTo = unit.startMin + sessionMinutes;
                        return (
                          <li key={unit.startMin}>
                            <button
                              type="button"
                              disabled={!fits}
                              aria-pressed={Boolean(inSelection)}
                              onClick={() =>
                                setSelection(
                                  inSelection || sessionMinutes <= 0
                                    ? null
                                    : { startMin: unit.startMin, endMin: runsTo },
                                )
                              }
                              className={cn(
                                "w-full rounded-lg border px-3 py-3 text-left transition-colors",
                                inSelection
                                  ? "border-lime-400 bg-lime-400 text-ink-950"
                                  : fits
                                    ? "border-white/15 bg-white/[0.06] text-white hover:border-lime-400/60 hover:bg-white/10"
                                    : "cursor-not-allowed border-white/5 bg-white/[0.02] text-ink-500",
                              )}
                            >
                              <span className="block whitespace-nowrap text-base font-semibold">
                                {formatCompactRange(unit.startMin, unit.endMin)}
                              </span>
                              <span className={cn("block text-sm", inSelection ? "text-ink-950/70" : "text-ink-300")}>
                                {fits || inSelection
                                  ? `${availability.oversPerSlot} overs · ${formatCurrency(ball?.pricePerSlot)}`
                                  : free
                                    // Free itself, but a later quarter it needs is not.
                                    ? "Not enough time"
                                    : statusLabel(unit.status)}
                              </span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              </>
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
                          {/* The full range, not just the start: "6 AM" alone reads as
                              the whole booking and customers asked what they were buying. */}
                          <span className="block whitespace-nowrap text-base font-semibold">
                            {formatCompactRange(unit.startMin, unit.endMin)}
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

            {selection && readyToHold ? (
              <div className="mt-6 rounded-lg border border-lime-400/30 bg-lime-400/10 p-4">
                {/* Stacked on a phone so Continue is a full-width thumb target under the
                    slot it confirms, rather than a small button pushed to one side. */}
                <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <p className="font-semibold text-white">{formatRange(selection.startMin, selection.endMin)}</p>
                    <p className="text-sm text-ink-400">
                      {isOvers && overs ? `${overs} overs · ` : ""}
                      {minutesToDuration(selection.endMin - selection.startMin)}
                      {isOvers && ball ? ` · ${ball.name}` : ""} · {formatCurrency(selectedAmount)}
                      {isOvers && payAtVenue ? " · pay at the ground" : ""}
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
              <Row
                label="Booking"
                value={hold.resourceName && hold.resourceName !== hold.facilityName
                  ? `${hold.facilityName} · ${hold.resourceName}`
                  : hold.facilityName}
              />
              <Row label="Address" value={location?.address ?? "—"} />
              <Row label="Date" value={formatBusinessDate(hold.date)} />
              <Row label="Time" value={formatRange(hold.startMin, hold.endMin)} />
              {hold.overs !== null ? <Row label="Overs" value={`${hold.overs} overs`} /> : null}
              {hold.ballTypeName ? <Row label="Ball" value={hold.ballTypeName} /> : null}
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
                    onChange={(e) => {
                      setPhone(e.target.value);
                      // Editing a digit means the verified number is no longer the
                      // one being booked with, so the proof stops counting.
                      setOtpSent(false);
                      setOtpError(null);
                      setOtpNotice(null);
                    }}
                    placeholder="10-digit mobile number"
                    required
                  />
                  <p className="mt-1.5 text-xs text-ink-400">We will confirm your booking on WhatsApp.</p>
                </div>
              </div>

              {otpEnabled ? (
                <div className="mt-4 rounded-lg border border-white/10 bg-white/[0.03] p-4">
                  {verifiedPhone === normalisePhone(phone) ? (
                    <p className="flex items-center gap-2 text-sm font-medium text-lime-400">
                      <ShieldCheck className="h-4 w-4" aria-hidden="true" />
                      {normalisePhone(phone)} verified
                    </p>
                  ) : (
                    <>
                      <p className="text-sm font-medium text-white">Verify your mobile number</p>
                      <p className="mt-1 text-xs text-ink-400">
                        We send a 6-digit code so we can reach you about this booking.
                      </p>

                      {!otpSent ? (
                        <Button
                          variant="secondary"
                          className="mt-3"
                          disabled={!phoneLooksValid(phone) || otpBusy}
                          onClick={sendCode}
                        >
                          {otpBusy ? <Spinner /> : null}
                          Send code
                        </Button>
                      ) : (
                        <div className="mt-3 flex flex-wrap items-end gap-2">
                          <div className="w-40">
                            <label className="field-label" htmlFor="otp-code">
                              6-digit code
                            </label>
                            <input
                              id="otp-code"
                              className="field-input tracking-[0.3em]"
                              inputMode="numeric"
                              autoComplete="one-time-code"
                              maxLength={6}
                              value={otpCode}
                              onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, ""))}
                            />
                          </div>
                          <Button disabled={otpCode.length !== 6 || otpBusy} onClick={checkCode}>
                            {otpBusy ? <Spinner /> : null}
                            Verify
                          </Button>
                          <Button variant="ghost" disabled={resendIn > 0 || otpBusy} onClick={sendCode}>
                            {resendIn > 0 ? `Resend in ${resendIn}s` : "Resend code"}
                          </Button>
                        </div>
                      )}

                      {otpNotice ? (
                        <Alert tone="info" className="mt-3">
                          {otpNotice}
                        </Alert>
                      ) : null}
                      {otpError ? (
                        <Alert tone="error" className="mt-3">
                          {otpError}
                        </Alert>
                      ) : null}
                    </>
                  )}
                </div>
              ) : null}

              <Button
                size="lg"
                className="mt-5 w-full sm:w-auto"
                disabled={!detailsValid || holdExpired}
                onClick={() => setStep("payment")}
              >
                {hold.payAtVenue ? "Review and confirm" : "Continue to payment"}
              </Button>
            </section>
          ) : null}

          {step === "payment" && hold.payAtVenue ? (
            <section className="card" aria-labelledby="venue-heading">
              <h2 id="venue-heading" className="text-lg font-semibold text-white">
                Pay {formatCurrency(hold.amount)} at the ground
              </h2>
              <p className="mt-1 text-sm text-ink-400">
                Nothing to pay online for a session this size. Your slot is confirmed as soon as you book, and you
                settle up when you arrive.
              </p>

              <dl className="mt-4 divide-y divide-white/10 text-sm">
                <Row label="Name" value={name} />
                <Row label="Mobile" value={phone} />
                <Row label="Ground" value={hold.locationName} />
                <Row label="Booking" value={hold.facilityName} />
                <Row label="Date" value={formatBusinessDate(hold.date)} />
                <Row label="Time" value={formatRange(hold.startMin, hold.endMin)} />
                {hold.overs !== null ? <Row label="Overs" value={`${hold.overs} overs`} /> : null}
                {hold.ballTypeName ? <Row label="Ball" value={hold.ballTypeName} /> : null}
                <Row label="To pay at the ground" value={formatCurrency(hold.amount)} strong />
              </dl>

              {error ? (
                <Alert tone="error" className="mt-3">
                  {error}
                </Alert>
              ) : null}

              <Button className="mt-4 w-full" size="lg" disabled={submitting || holdExpired} onClick={submitBooking}>
                {submitting ? <Spinner /> : null}
                {submitting ? "Confirming…" : "Confirm booking"}
              </Button>
            </section>
          ) : null}

          {step === "payment" && !hold.payAtVenue ? (
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
                  <Row label="Booking" value={hold.facilityName} />
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
