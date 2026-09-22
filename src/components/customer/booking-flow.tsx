"use client";

import * as React from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { ArrowLeft, Check, ChevronDown, Clock, Copy, ImageUp, MapPin, Navigation, ShieldCheck, Trash2 } from "lucide-react";
import { ApiError, api, errorMessage } from "@/lib/client";
import { freeRunLength, hoursTouched, runIsFree } from "@/lib/booking/schedule";
import { facilityPhoto, locationCover } from "@/lib/photos";
import { Msg91OtpWidget } from "./msg91-otp-widget";
import { formatBusinessDate, formatCompactRange, formatMinutes, formatRange, minutesToDuration } from "@/lib/time";
import { Alert, Button, EmptyState, FieldError, Spinner, cn, formatCurrency } from "@/components/ui/primitives";
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
  /** This date is charged at the ground's weekend rates. */
  weekendRate?: boolean;
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

/**
 * The screenshot limits, mirrored from the server.
 *
 * The server enforces both again from the bytes it actually receives — a browser
 * check is a courtesy that saves a customer a slow upload, never the rule.
 */
const MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024;
const ALLOWED_SCREENSHOT_TYPES = ["image/jpeg", "image/png", "image/webp"];

/** "6.2 MB", so an oversized file can be told how oversized it is. */
function formatFileSize(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
}

/**
 * Adds days to a "YYYY-MM-DD" business date without touching the browser clock.
 *
 * Total on purpose. `Date.UTC` with a NaN anywhere in it produces an Invalid
 * Date, and `toISOString` on one throws a RangeError — which, thrown from a
 * render, is the whole page replaced by "a client-side exception has occurred".
 * One facility carrying a `bookingWindowDays` this file never saw was enough,
 * because `Math.max` over it is NaN. The window falls back to the date itself,
 * which narrows the picker rather than destroying the page.
 */
function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  if (![y, m, d, days].every((n) => Number.isFinite(n))) return date;
  const shifted = new Date(Date.UTC(y!, m! - 1, d! + days));
  return Number.isNaN(shifted.getTime()) ? date : shifted.toISOString().slice(0, 10);
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
  otpWidget,
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
  /**
   * MSG91's widget credentials, or null when they are not configured. Read on the
   * server so they are not in a NEXT_PUBLIC_ variable; the AuthKey that makes a
   * verification mean anything is never part of this and stays server-side.
   */
  otpWidget: { widgetId: string; tokenAuth: string } | null;
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

  /** The exact number that was verified, so editing a digit invalidates it. */
  const [verifiedPhone, setVerifiedPhone] = React.useState<string | null>(null);

  const [file, setFile] = React.useState<File | null>(null);
  const [preview, setPreview] = React.useState<string | null>(null);
  const [screenshotKey, setScreenshotKey] = React.useState<string | null>(null);
  const [uploading, setUploading] = React.useState(false);
  /**
   * Why the chosen file is not uploaded.
   *
   * The two are treated completely differently and must never be conflated:
   * something the customer can fix blocks the booking until they fix it, while
   * our storage being down does not cost them a booking they have already paid
   * for. The server decides which is which — this only mirrors its answer.
   */
  const [uploadProblem, setUploadProblem] = React.useState<
    { kind: "FILE"; message: string } | { kind: "STORAGE"; message: string } | null
  >(null);
  /** The 12-digit UPI reference. This, not the image, is what a booking needs. */
  const [utr, setUtr] = React.useState("");
  const utrDigits = utr.replace(/\D/g, "");
  const utrValid = utrDigits.length === 12;

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

  /**
   * The request this component is currently waiting on.
   *
   * Every reply checks it before touching state, so a slow answer for a date the
   * customer has already moved away from is dropped instead of overwriting the
   * one they are looking at. Without this a stale *failure* was the worst case:
   * an abandoned past date — which an iOS date wheel produces on its way to the
   * date being aimed at — printed "That date has already passed" over a perfectly
   * good future one, and only a reload cleared it.
   */
  const availabilityRequest = React.useRef(0);

  const loadAvailability = React.useCallback(async ({ silent = false }: { silent?: boolean } = {}) => {
    if (!resourceId || !date) return;
    const ticket = (availabilityRequest.current += 1);
    const current = () => availabilityRequest.current === ticket;

    // A background poll must not blank the grid the customer is reading.
    if (!silent) setLoadingAvailability(true);
    setAvailabilityError(null);
    try {
      const data = await api<AvailabilityResponse>(
        `/api/availability?resourceId=${encodeURIComponent(resourceId)}&date=${encodeURIComponent(date)}`,
      );
      if (current()) setAvailability(data);
    } catch (err) {
      // A failed background poll leaves the last good list on screen; the hold
      // attempt is re-checked server-side anyway.
      if (!silent && current()) {
        setAvailability(null);
        setAvailabilityError(errorMessage(err));
      }
    } finally {
      if (!silent && current()) setLoadingAvailability(false);
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

  /**
   * What the customer could have from a start that cannot hold their session —
   * the clash is usually a booking three quarters away, which they cannot see
   * from the button they pressed.
   */
  const oversThatFitAt = React.useCallback(
    (startMin: number) =>
      availability && sessionSlots > 0
        ? freeRunLength(availability.slotMinutes, freeStarts, startMin, sessionSlots) * availability.oversPerSlot
        : 0,
    [availability, freeStarts, sessionSlots],
  );

  const anyStartFits = React.useMemo(
    () => units.some((u) => u.status === "AVAILABLE" && fitsAt(u.startMin)),
    [units, fitsAt],
  );

  /**
   * Bowling runs in quarter-hours, so a day is sixty-eight buttons — a wall on a
   * phone. Grouped by the hour the customer picks the hour first and then the
   * exact start, which is how they think about it anyway ("about seven-ish").
   */
  const hourGroups = React.useMemo(() => {
    const groups = new Map<number, AvailabilityUnit[]>();
    for (const unit of units) {
      const hourMin = Math.floor(unit.startMin / 60) * 60;
      groups.set(hourMin, [...(groups.get(hourMin) ?? []), unit]);
    }
    return [...groups.entries()].map(([hourMin, own]) => ({ hourMin, units: own }));
  }, [units]);

  const firstFittingHour = React.useMemo(
    () => hourGroups.find((g) => g.units.some((u) => u.status === "AVAILABLE" && fitsAt(u.startMin)))?.hourMin ?? null,
    [hourGroups, fitsAt],
  );

  // "auto" follows the first hour with room in it; "none" is the customer having
  // closed that hour themselves, which a background refresh must not undo.
  const [openHour, setOpenHour] = React.useState<number | "auto" | "none">("auto");
  React.useEffect(() => {
    setOpenHour("auto");
  }, [resourceId, date, overs]);

  const activeHour = openHour === "auto" ? firstFittingHour : openHour === "none" ? null : openHour;

  /**
   * A long session runs past the hour it starts in — 60 overs from 6:45 covers
   * 6:45 to 8:15 — so every hour it touches is opened, and the customer can see
   * the whole run highlighted instead of a single lit square and two hidden ones.
   */
  const expandedHours = React.useMemo(() => {
    const open = new Set<number>();
    if (activeHour !== null) open.add(activeHour);
    if (selection) for (const hour of hoursTouched(selection.startMin, selection.endMin)) open.add(hour);
    return open;
  }, [activeHour, selection]);

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
    setUtr("");
    setStep("slots");
    void loadAvailability();
  }

  async function uploadScreenshot(chosen: File) {
    setUploading(true);
    setUploadProblem(null);
    try {
      const form = new FormData();
      form.append("file", chosen);
      const result = await api<{ key: string }>("/api/uploads", { method: "POST", body: form });
      setScreenshotKey(result.key);
    } catch (err) {
      setScreenshotKey(null);
      /*
       * UPLOAD_FAILED is the storage provider, and only then may the booking go
       * through without the image. Everything else — a file too large for the
       * server, the wrong type, a truncated body — is the customer's to fix, and
       * the Book button stays shut until they do.
       */
      const storage = err instanceof ApiError && err.code === "UPLOAD_FAILED";
      setUploadProblem(
        storage
          ? {
              kind: "STORAGE",
              message:
                "We are having trouble uploading the payment screenshot right now. " +
                "Please enter your UTR number below so we can verify the payment manually.",
            }
          : { kind: "FILE", message: errorMessage(err) },
      );
    } finally {
      setUploading(false);
    }
  }

  async function onFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const chosen = event.target.files?.[0];
    event.target.value = ""; // allows re-picking the same file after a failure
    if (!chosen) return;

    setError(null);
    setScreenshotKey(null);

    // Checked here so an obviously wrong file never costs the customer an upload
    // on a phone connection. The server checks the same two things again from the
    // bytes themselves, because this check is a courtesy and that one is the rule.
    if (!ALLOWED_SCREENSHOT_TYPES.includes(chosen.type)) {
      setFile(null);
      setUploadProblem({ kind: "FILE", message: "Please upload a JPG, PNG or WebP screenshot." });
      return;
    }
    if (chosen.size > MAX_SCREENSHOT_BYTES) {
      setFile(null);
      setUploadProblem({
        kind: "FILE",
        message: `Payment screenshot must be less than 5 MB. Please upload a smaller file. (Yours is ${formatFileSize(chosen.size)}.)`,
      });
      return;
    }
    if (chosen.size === 0) {
      setFile(null);
      setUploadProblem({ kind: "FILE", message: "That file is empty. Please choose the screenshot again." });
      return;
    }

    if (preview) URL.revokeObjectURL(preview);
    setFile(chosen);
    setPreview(URL.createObjectURL(chosen));
    await uploadScreenshot(chosen);
  }

  function clearFile() {
    if (preview) URL.revokeObjectURL(preview);
    setFile(null);
    setPreview(null);
    setScreenshotKey(null);
    setUploadProblem(null);
  }

  async function submitBooking() {
    // The server decides all of this again from the hold and its own records;
    // this only stops a request that is certain to be refused.
    if (submitting || !canSubmitPayment) return;
    setSubmitting(true);
    setError(null);
    try {
      await api("/api/bookings", {
        method: "POST",
        body: JSON.stringify({
          customerName: name,
          customerPhone: phone,
          paymentScreenshotKey: screenshotKey,
          utr: hold?.payAtVenue ? null : utrDigits,
        }),
      });
      router.push("/booking/success");
    } catch (err) {
      setError(errorMessage(err));
      setSubmitting(false);
    }
  }

  const phoneVerified = !otpEnabled || verifiedPhone === normalisePhone(phone);
  /**
   * What is wrong with the details, per field.
   *
   * These used to be invisible: the button simply sat there disabled, so a
   * customer who typed a single-letter name had nothing at all telling them why
   * nothing happened when they pressed it.
   */
  const nameProblem = name.trim().length === 0
    ? "Enter your name so we know who the booking is for."
    : name.trim().length < 2
      ? "Please enter your full name — at least 2 letters."
      : null;
  const phoneProblem = phone.trim().length === 0
    ? "Enter the mobile number we should reach you on."
    : !phoneLooksValid(phone)
      ? "Enter a 10-digit Indian mobile number, starting 6, 7, 8 or 9."
      : null;

  const detailsValid = !nameProblem && !phoneProblem && phoneVerified;

  /**
   * Whether the payment step may be submitted, and if not, what is missing.
   *
   * A screenshot is required. The single exception is a storage failure, where
   * the image was fine and we could not take it — refusing the booking then would
   * charge a customer who has already paid for our own outage.
   */
  const storageIsDown = uploadProblem?.kind === "STORAGE";
  const paymentProblem = hold?.payAtVenue
    ? null
    : !utrValid
      ? utrDigits.length === 0
        ? "Enter the 12-digit UTR from your payment app."
        : `The UTR is 12 digits — you have entered ${utrDigits.length}.`
      : uploading
        ? "Waiting for the screenshot to finish uploading…"
        : uploadProblem?.kind === "FILE"
          ? uploadProblem.message
          : !screenshotKey && !storageIsDown
            ? "Please upload a screenshot of your payment."
            : null;
  const canSubmitPayment = !paymentProblem && !holdExpired;

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
                      <Image src={locationCover(l.slug, l.image)} alt="" fill sizes="56px" className="object-cover" />
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
                /*
                 * `min` and `max` are only hints: the iOS wheel scrolls straight
                 * past both, and every intermediate date it passes through fires
                 * a change. So the clamp is real rather than advisory — ISO dates
                 * compare correctly as strings — and a date outside the window is
                 * never requested at all. Clearing the field would leave the grid
                 * showing another day's slots, so that lands on today too.
                 */
                onChange={(e) => {
                  const picked = e.target.value;
                  const latest = addDays(today, bookingWindowDays);
                  if (!picked) return setDate(today);
                  setDate(picked < today ? today : picked > latest ? latest : picked);
                }}
              />
              <p className="mt-1.5 text-xs text-ink-400">{formatBusinessDate(date)} · times shown in IST</p>
            </div>
          </section>

          {/* Slots */}
          <section aria-labelledby="slots-heading" className="card">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <h2 id="slots-heading" className="flex flex-wrap items-center gap-2 text-lg font-semibold text-white">
                  4. {isOvers ? "Choose your session" : "Choose your time"}
                  {/* Says why the evening costs more than it did on Tuesday, before
                      the customer gets to the total and wonders. */}
                  {availability?.weekendRate ? (
                    <span className="rounded-full border border-lime-400/40 bg-lime-400/10 px-2 py-0.5 text-xs font-semibold text-lime-300">
                      Weekend rates
                    </span>
                  ) : null}
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
                    Pick the hour, then the exact start. Each slot is {availability.oversPerSlot} overs (
                    {minutesToDuration(availability.slotMinutes)})
                    {sessionSlots > 1 ? `, and ${overs} overs runs on for ${minutesToDuration(sessionMinutes)}` : ""}.
                  </p>

                  {!anyStartFits ? (
                    <EmptyState
                      title="No free run that long on this date."
                      hint="Try fewer overs, another date or another ground."
                    />
                  ) : (
                    <div className="mt-3 space-y-2">
                      {hourGroups.map((group) => {
                        const expanded = expandedHours.has(group.hourMin);
                        const freeStartCount = group.units.filter((u) => u.status === "AVAILABLE" && fitsAt(u.startMin)).length;
                        const holdsSelection = selection
                          ? group.units.some((u) => u.startMin >= selection.startMin && u.startMin < selection.endMin)
                          : false;
                        return (
                          <div
                            key={group.hourMin}
                            className={cn(
                              "overflow-hidden rounded-lg border",
                              holdsSelection ? "border-lime-400/60 bg-lime-400/[0.06]" : "border-white/10",
                            )}
                          >
                            <button
                              type="button"
                              aria-expanded={expanded}
                              onClick={() => setOpenHour(expanded && !holdsSelection ? "none" : group.hourMin)}
                              className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-white/5"
                            >
                              <span className="text-base font-semibold text-white">{formatMinutes(group.hourMin)}</span>
                              <span className="flex items-center gap-2 text-sm">
                                <span className={freeStartCount > 0 ? "text-ink-300" : "text-ink-500"}>
                                  {freeStartCount > 0
                                    ? `${freeStartCount} start${freeStartCount === 1 ? "" : "s"} free`
                                    : group.units.some((u) => u.status === "AVAILABLE")
                                      ? `Too short for ${overs} overs`
                                      : "Nothing free"}
                                </span>
                                <ChevronDown
                                  className={cn("h-4 w-4 shrink-0 text-ink-400 transition-transform", expanded ? "rotate-180" : "")}
                                  aria-hidden="true"
                                />
                              </span>
                            </button>

                            {expanded ? (
                              <ul className="grid grid-cols-2 gap-2 border-t border-white/10 p-3">
                                {group.units.map((unit) => {
                                  const inSelection =
                                    selection && unit.startMin >= selection.startMin && unit.startMin < selection.endMin;
                                  const free = unit.status === "AVAILABLE";
                                  const fits = free && fitsAt(unit.startMin);
                                  const runsTo = unit.startMin + sessionMinutes;
                                  return (
                                    <li key={unit.startMin}>
                                      <button
                                        type="button"
                                        disabled={!fits && !inSelection}
                                        aria-pressed={Boolean(inSelection)}
                                        onClick={() => {
                                          const next =
                                            inSelection || sessionMinutes <= 0
                                              ? null
                                              : { startMin: unit.startMin, endMin: runsTo };
                                          setSelection(next);
                                          if (next) setOpenHour(group.hourMin);
                                        }}
                                        className={cn(
                                          "w-full rounded-lg border px-3 py-3 text-left transition-colors",
                                          inSelection
                                            ? "border-lime-400 bg-lime-400 text-ink-950"
                                            : fits
                                              ? "border-white/15 bg-white/[0.06] text-white hover:border-lime-400/60 hover:bg-white/10"
                                              : "cursor-not-allowed border-white/5 bg-white/[0.02] text-ink-500",
                                        )}
                                      >
                                        <span className="block whitespace-nowrap text-[15px] font-semibold">
                                          {formatCompactRange(unit.startMin, unit.endMin)}
                                        </span>
                                        <span className={cn("block text-sm", inSelection ? "text-ink-950/70" : "text-ink-300")}>
                                          {fits || inSelection
                                            ? `${availability.oversPerSlot} overs · ${formatCurrency(ball?.pricePerSlot)}`
                                            : free
                                              // Free itself, but a later quarter it needs is not. Say how far
                                              // the machine is actually theirs from here.
                                              ? `Only ${oversThatFitAt(unit.startMin)} overs fit`
                                              : statusLabel(unit.status)}
                                        </span>
                                      </button>
                                    </li>
                                  );
                                })}
                              </ul>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
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
                    // Only once they have typed something: a red box on a field
                    // nobody has reached yet is a telling-off, not a hint.
                    aria-invalid={nameProblem && name.length > 0 ? true : undefined}
                    aria-describedby={nameProblem && name.length > 0 ? "customer-name-error" : undefined}
                  />
                  {nameProblem && name.length > 0 ? (
                    <FieldError id="customer-name-error">{nameProblem}</FieldError>
                  ) : null}
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
                    aria-invalid={phoneProblem && phone.length > 0 ? true : undefined}
                    aria-describedby={phoneProblem && phone.length > 0 ? "customer-phone-error" : undefined}
                  />
                  {phoneProblem && phone.length > 0 ? (
                    <FieldError id="customer-phone-error">{phoneProblem}</FieldError>
                  ) : (
                    <p className="mt-1.5 text-xs text-ink-400">We will confirm your booking on WhatsApp.</p>
                  )}
                </div>
              </div>

              {otpEnabled ? (
                <div className="mt-4 rounded-lg border border-white/10 bg-white/[0.03] p-4">
                  {verifiedPhone === normalisePhone(phone) ? (
                    <p className="flex items-center gap-2 text-sm font-medium text-lime-400">
                      <ShieldCheck className="h-4 w-4" aria-hidden="true" />
                      {normalisePhone(phone)} verified
                    </p>
                  ) : otpWidget ? (
                    <>
                      <p className="text-sm font-medium text-white">Verify your mobile number</p>
                      <p className="mb-3 mt-1 text-xs text-ink-400">
                        So we can reach you about this booking.
                      </p>
                      <Msg91OtpWidget
                        widgetId={otpWidget.widgetId}
                        tokenAuth={otpWidget.tokenAuth}
                        phone={phone}
                        onVerified={setVerifiedPhone}
                      />
                    </>
                  ) : (
                    /*
                     * Verification is on but there is nothing to verify with. Said
                     * plainly rather than shown as a broken code box: the booking
                     * would be refused by the server anyway, and a customer who
                     * rings up is a better outcome than one who gives up at a form
                     * that never works.
                     */
                    <Alert tone="error">
                      Mobile verification is unavailable right now. Please call us and we will take your booking over
                      the phone.
                    </Alert>
                  )}
                </div>
              ) : null}

              {/* Named here as well as under the field. On a phone the keyboard
                  covers the inputs, so the only thing the customer can see when
                  they reach for the button is the button. */}
              {!detailsValid && (name.length > 0 || phone.length > 0) ? (
                <p className="mt-4 text-sm font-medium text-amber-300">
                  {nameProblem ?? phoneProblem ?? "Verify your mobile number to continue."}
                </p>
              ) : null}

              <Button
                size="lg"
                className="mt-3 w-full sm:w-auto"
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
                  Pay using any UPI app, then enter the UTR number from your payment below.
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

              {/* The UTR comes first and the screenshot second, because that is the
                  order of what matters: the reference is what the payment is traced
                  by in the bank statement, and the image is corroboration. */}
              <section className="card" aria-labelledby="utr-heading">
                <h2 id="utr-heading" className="text-lg font-semibold text-white">
                  Enter your UTR number
                </h2>
                <p className="mt-1 text-sm text-ink-400">
                  The 12-digit reference in your payment app, shown as UTR, UPI reference or transaction ID.
                </p>

                <label className="mt-4 block">
                  <span className="text-sm font-medium text-ink-200">UTR number</span>
                  <input
                    className="field-input mt-1.5 font-mono tracking-wider"
                    value={utr}
                    onChange={(e) => setUtr(e.target.value.replace(/[^\d\s-]/g, "").slice(0, 20))}
                    inputMode="numeric"
                    autoComplete="off"
                    placeholder="123456789012"
                    aria-describedby="utr-help"
                  />
                </label>
                <p id="utr-help" className="mt-1.5 text-xs text-ink-400">
                  {utr.length === 0
                    ? "Open your payment in PhonePe, GPay or Paytm and copy the UTR."
                    : utrValid
                      ? "Looks right."
                      : `${utrDigits.length} of 12 digits — please check the number.`}
                </p>
              </section>

              <section className="card" aria-labelledby="upload-heading">
                <h2 id="upload-heading" className="text-lg font-semibold text-white">
                  Add your payment screenshot
                </h2>
                <p className="mt-1 text-sm text-ink-400">JPG, PNG or WebP · up to 5 MB · required</p>

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
                      <p className="mt-0.5 text-xs text-ink-400">{formatFileSize(file.size)}</p>
                      <p className="mt-2 text-sm">
                        {uploading ? (
                          <span className="flex items-center gap-2 text-ink-400">
                            <Spinner /> Uploading…
                          </span>
                        ) : screenshotKey ? (
                          <span className="flex items-center gap-1.5 font-medium text-lime-400">
                            <Check className="h-4 w-4" aria-hidden="true" /> Uploaded
                          </span>
                        ) : storageIsDown ? (
                          <span className="text-amber-300">Could not be uploaded — see below.</span>
                        ) : (
                          <span className="text-red-300">Not uploaded.</span>
                        )}
                      </p>
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        {/* Offered on any failure. A store that was down a moment
                            ago is often back, and the customer would rather send
                            the image than have it checked by hand. */}
                        {!uploading && !screenshotKey ? (
                          <Button variant="secondary" size="sm" onClick={() => void uploadScreenshot(file)}>
                            Try again
                          </Button>
                        ) : null}
                        {/*
                          A label rather than a button, so it opens the picker
                          itself. The file input used to exist only in the empty
                          dropzone, which meant that once a file was chosen and
                          then refused — a PDF the browser had labelled a PNG, say
                          — there was nothing on screen that would open the picker
                          again without first clearing the one that failed.
                        */}
                        <label
                          className={cn(
                            "inline-flex h-9 cursor-pointer items-center gap-2 rounded-full px-3 text-sm font-semibold text-ink-300 transition-colors hover:bg-white/10",
                            uploading && "pointer-events-none opacity-60",
                          )}
                        >
                          <Trash2 className="h-4 w-4" aria-hidden="true" />
                          Choose another
                          <input
                            type="file"
                            accept="image/jpeg,image/png,image/webp"
                            className="sr-only"
                            disabled={uploading}
                            onChange={onFileChange}
                          />
                        </label>
                      </div>
                    </div>
                  </div>
                )}

                {/*
                  The two failures look nothing alike on purpose. One is a
                  problem with the file, which the customer fixes and the booking
                  waits for. The other is ours, which must not cost them a booking
                  they have already paid for.
                */}
                {uploadProblem?.kind === "FILE" ? (
                  <Alert tone="error" className="mt-4">
                    {uploadProblem.message}
                  </Alert>
                ) : null}
                {storageIsDown ? (
                  <Alert tone="warning" className="mt-4">
                    <p className="font-semibold">{uploadProblem.message}</p>
                    <p className="mt-1">
                      Your slot is still held. We will match your payment against the UTR above, so please check
                      that number is typed exactly right.
                    </p>
                  </Alert>
                ) : null}
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
                  <Row label="UTR" value={utrValid ? utrDigits : "Not entered yet"} />
                  <Row
                    label="Screenshot"
                    value={screenshotKey ? "Uploaded" : storageIsDown ? "Will be checked by hand" : "Not uploaded"}
                  />
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

                {/* A disabled button with no explanation is the thing customers
                    read as a broken site, so it always says what it is waiting for. */}
                {paymentProblem && !submitting ? (
                  <p className="mt-4 text-sm font-medium text-amber-300">{paymentProblem}</p>
                ) : null}

                <Button
                  className="mt-3 w-full"
                  size="lg"
                  disabled={!canSubmitPayment || submitting}
                  onClick={submitBooking}
                >
                  {submitting ? <Spinner /> : null}
                  {submitting ? "Submitting…" : "Book now"}
                </Button>
                {!utrValid ? (
                  <p className="mt-2 text-center text-xs text-ink-400">
                    Enter your 12-digit UTR number above to finish.
                  </p>
                ) : null}
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
