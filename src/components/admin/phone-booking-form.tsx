"use client";

import * as React from "react";
import Link from "next/link";
import { Check, ChevronDown, CircleCheck, IndianRupee, MapPin, User } from "lucide-react";
import { api, errorMessage } from "@/lib/client";
import { hoursTouched } from "@/lib/booking/schedule";
import { formatBusinessDate, formatCompactRange, formatMinutes, formatRange } from "@/lib/time";
import { Alert, Button, Spinner, cn, formatCurrency } from "@/components/ui/primitives";

export interface ManualBookingFacility {
  id: string;
  locationId: string;
  name: string;
  kind: "HOURLY" | "OVERS";
  oversPerSlot: number;
  ballTypes: Array<{ id: string; name: string; pricePerSlot: number }>;
  resources: Array<{ id: string; name: string }>;
}

interface DayUnit {
  startMin: number;
  endMin: number;
  price: number;
  status: string;
  booking: { reference: string; customerName: string } | null;
}

interface DayResponse {
  facility: { kind: string };
  config: { openMin: number; closeMin: number; slotMinutes: number };
  dayBlock: { reason: string } | null;
  units: DayUnit[];
}

/** One numbered step of the form, so the owner can see where they are on a call. */
function Step({
  n,
  title,
  hint,
  done,
  children,
}: {
  n: number;
  title: string;
  hint?: string;
  done?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-ink-200 bg-white p-4">
      <header className="flex items-center gap-2.5">
        <span
          className={cn(
            "grid h-6 w-6 shrink-0 place-items-center rounded-full text-xs font-bold",
            done ? "bg-pitch-600 text-white" : "bg-ink-100 text-ink-600",
          )}
        >
          {done ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : n}
        </span>
        <h3 className="text-sm font-semibold text-ink-900">{title}</h3>
        {hint ? <span className="ml-auto truncate text-xs text-ink-500">{hint}</span> : null}
      </header>
      <div className="mt-3">{children}</div>
    </section>
  );
}

/**
 * Writing in a booking somebody has just rung up about.
 *
 * Its own tab rather than a dialog on the bookings list: it is what the owner
 * does most while the phone is ringing, so it is one tap from anywhere.
 *
 * It shows the same day the customer would see, off the same endpoint the
 * availability screen uses, so the owner is never picking a slot from a picture
 * that is minutes out of date. Nothing here states a price: the total shown is
 * the schedule's, and the server prices the booking again when it is saved.
 */
export function PhoneBookingForm({
  locations,
  facilities,
  today,
}: {
  locations: Array<{ id: string; name: string }>;
  facilities: ManualBookingFacility[];
  /** Today in Asia/Kolkata, from the server — never the admin's device clock. */
  today: string;
}) {
  /** The booking just added, said at the top until the next one is started. */
  const [added, setAdded] = React.useState<{ reference: string; name: string } | null>(null);

  const [locationId, setLocationId] = React.useState(locations[0]?.id ?? "");
  const facilitiesHere = React.useMemo(
    () => facilities.filter((f) => f.locationId === locationId),
    [facilities, locationId],
  );
  const [facilityId, setFacilityId] = React.useState(facilitiesHere[0]?.id ?? "");
  const facility = facilitiesHere.find((f) => f.id === facilityId);
  const [resourceId, setResourceId] = React.useState(facility?.resources[0]?.id ?? "");
  const [date, setDate] = React.useState(today);

  const [day, setDay] = React.useState<DayResponse | null>(null);
  const [loadingDay, setLoadingDay] = React.useState(false);
  const [dayError, setDayError] = React.useState<string | null>(null);

  /** Hourly: the start minutes the owner tapped. Overs: just the one start. */
  const [picked, setPicked] = React.useState<number[]>([]);
  const [overs, setOvers] = React.useState(0);
  const [ballTypeId, setBallTypeId] = React.useState("");
  /** Which hour's quarter-hours are open. Whole hours are what people say on the phone. */
  const [openHour, setOpenHour] = React.useState<number | null>(null);

  const [name, setName] = React.useState("");
  const [phone, setPhone] = React.useState("");
  const [collected, setCollected] = React.useState("0");
  const [note, setNote] = React.useState("");

  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Keep the three selects pointing at something that exists under the one above.
  React.useEffect(() => {
    if (facilitiesHere.some((f) => f.id === facilityId)) return;
    setFacilityId(facilitiesHere[0]?.id ?? "");
  }, [facilitiesHere, facilityId]);

  React.useEffect(() => {
    if (!facility) return;
    if (!facility.resources.some((r) => r.id === resourceId)) setResourceId(facility.resources[0]?.id ?? "");
    if (facility.kind === "OVERS") {
      if (!facility.ballTypes.some((b) => b.id === ballTypeId)) setBallTypeId(facility.ballTypes[0]?.id ?? "");
      if (overs <= 0) setOvers(facility.oversPerSlot);
    }
  }, [facility, resourceId, ballTypeId, overs]);

  React.useEffect(() => {
    setPicked([]);
    setOpenHour(null);
  }, [resourceId, date, overs]);

  const loadDay = React.useCallback(async () => {
    if (!resourceId || !date) return;
    setLoadingDay(true);
    setDayError(null);
    try {
      setDay(await api<DayResponse>(`/api/admin/day?resourceId=${resourceId}&date=${date}`));
    } catch (err) {
      setDay(null);
      setDayError(errorMessage(err));
    } finally {
      setLoadingDay(false);
    }
  }, [resourceId, date]);

  React.useEffect(() => {
    void loadDay();
  }, [loadDay]);

  function reset() {
    setPicked([]);
    setOpenHour(null);
    setName("");
    setPhone("");
    setCollected("0");
    setNote("");
    setError(null);
  }

  // Memoised: a fresh [] each render would re-run everything derived from it.
  const units = React.useMemo(() => day?.units ?? [], [day]);
  const slotMinutes = day?.config.slotMinutes ?? 60;
  const isOvers = facility?.kind === "OVERS";
  const slotsNeeded = isOvers && facility.oversPerSlot > 0 ? Math.round(overs / facility.oversPerSlot) : 1;

  /** Overs run on consecutively — the owner picks where they start, not every quarter. */
  const oversRunFrom = React.useCallback(
    (startMin: number): DayUnit[] | null => {
      const run: DayUnit[] = [];
      for (let i = 0; i < slotsNeeded; i += 1) {
        const unit = units.find((u) => u.startMin === startMin + i * slotMinutes);
        if (!unit || unit.status !== "AVAILABLE") return null;
        run.push(unit);
      }
      return run;
    },
    [units, slotsNeeded, slotMinutes],
  );

  const selectedUnits = React.useMemo(() => {
    if (isOvers) return picked.length === 1 ? (oversRunFrom(picked[0]!) ?? []) : [];
    return units.filter((u) => picked.includes(u.startMin)).sort((a, b) => a.startMin - b.startMin);
  }, [picked, units, isOvers, oversRunFrom]);

  // Half an hour here and half an hour two hours later is two bookings, not one.
  const contiguous =
    selectedUnits.length > 0 && selectedUnits.every((u, i) => i === 0 || u.startMin === selectedUnits[i - 1]!.endMin);

  /**
   * A machine sold in quarter-hours puts sixty-eight buttons on one screen, which
   * is not a thing anybody scans while a customer is talking. So the day is shown
   * as hours — the unit people speak in — and only the hour that is open shows
   * its quarters underneath.
   */
  const hourGroups = React.useMemo(() => {
    const groups = new Map<number, DayUnit[]>();
    for (const unit of units) {
      const hour = Math.floor(unit.startMin / 60) * 60;
      groups.set(hour, [...(groups.get(hour) ?? []), unit]);
    }
    return [...groups.entries()].map(([hour, own]) => ({ hour, units: own }));
  }, [units]);

  const splitByQuarter = slotMinutes < 60;
  // A selected session that spans two hours keeps both of them open.
  const expandedHours = React.useMemo(() => {
    const hours = new Set<number>();
    if (openHour !== null) hours.add(openHour);
    if (selectedUnits.length > 0) {
      for (const hour of hoursTouched(selectedUnits[0]!.startMin, selectedUnits[selectedUnits.length - 1]!.endMin)) {
        hours.add(hour);
      }
    }
    return hours;
  }, [openHour, selectedUnits]);

  const ball = facility?.ballTypes.find((b) => b.id === ballTypeId);
  const total = isOvers ? (ball?.pricePerSlot ?? 0) * slotsNeeded : selectedUnits.reduce((sum, u) => sum + u.price, 0);

  const collectedNumber = Number(collected || 0);
  const collectedValid = Number.isFinite(collectedNumber) && collectedNumber >= 0 && collectedNumber <= total;
  const phoneDigits = phone.replace(/\D/g, "").slice(-10);
  const whoValid = name.trim().length >= 2 && /^[6-9]\d{9}$/.test(phoneDigits);
  const canSave = !saving && contiguous && whoValid && collectedValid && (!isOvers || Boolean(ballTypeId));

  /**
   * The same rule as the customer's booking page: tap where it starts, then tap
   * where it ends, and everything between is taken — 6 AM then 10 AM is 6 to 11.
   * Tapping one hour at a time used to leave gaps the owner then had to fill in
   * by hand. Only extends over hours that are all free; any other tap starts
   * again from the hour tapped, and tapping a lone chosen hour clears it.
   */
  function pickUnit(startMin: number) {
    if (isOvers) return setPicked([startMin]);
    setPicked((current) => {
      if (current.length === 0) return [startMin];
      const first = Math.min(...current);
      const last = Math.max(...current);
      if (current.length === 1 && startMin === first) return [];
      if (startMin > last) {
        const run = units.filter((u) => u.startMin >= first && u.startMin <= startMin);
        if (run.every((u) => u.status === "AVAILABLE")) return run.map((u) => u.startMin);
      }
      return [startMin];
    });
  }

  async function save() {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      const start = selectedUnits[0]!.startMin;
      const created = await api<{ booking: { reference: string } }>("/api/admin/bookings", {
        method: "POST",
        body: JSON.stringify({
          resourceId,
          date,
          startMin: start,
          ...(isOvers ? { overs, ballTypeId } : { endMin: selectedUnits[selectedUnits.length - 1]!.endMin }),
          customerName: name.trim(),
          customerPhone: phoneDigits,
          amountPaid: Math.round(collectedNumber),
          note: note.trim(),
        }),
      });
      setAdded({ reference: created.booking.reference, name: name.trim() });
      reset();
      // The slot just taken shows as taken, ready for the next call.
      void loadDay();
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (err) {
      setError(errorMessage(err));
      // Somebody may have taken the slot while the owner was typing, so the grid
      // is refreshed rather than left showing it as free.
      void loadDay();
    } finally {
      setSaving(false);
    }
  }

  /** One quarter-hour or one hour, as a button. */
  const SlotButton = ({ unit, compact }: { unit: DayUnit; compact?: boolean }) => {
    const free = unit.status === "AVAILABLE";
    const fits = !isOvers || Boolean(oversRunFrom(unit.startMin));
    const selected = selectedUnits.some((u) => u.startMin === unit.startMin);
    return (
      <button
        type="button"
        disabled={!free || !fits}
        title={unit.booking ? `${unit.booking.customerName} · ${unit.booking.reference}` : undefined}
        onClick={() => pickUnit(unit.startMin)}
        className={cn(
          "flex h-12 flex-col items-center justify-center rounded-lg border px-1 text-xs font-semibold transition-colors",
          selected
            ? "border-pitch-600 bg-pitch-600 text-white shadow-sm"
            : free && fits
              ? "border-ink-200 bg-white text-ink-800 hover:border-pitch-500 hover:bg-pitch-50"
              : "cursor-not-allowed border-ink-100 bg-ink-50 text-ink-400 line-through",
        )}
      >
        <span>{compact ? formatCompactRange(unit.startMin, unit.endMin) : formatMinutes(unit.startMin)}</span>
        {!isOvers && free && unit.price > 0 ? (
          <span className={cn("text-[10px] font-medium", selected ? "text-white/80" : "text-ink-500")}>
            {formatCurrency(unit.price)}
          </span>
        ) : null}
      </button>
    );
  };

  return (
    <div className="space-y-3">
      {added ? (
        <Alert tone="success" className="flex flex-wrap items-center justify-between gap-2 rounded-xl">
          <span className="flex min-w-0 items-start gap-2 break-words">
            <CircleCheck className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            Booking {added.reference} added for {added.name}.
          </span>
          {/* Where the WhatsApp confirmation is sent from. */}
          <Link
            href={`/admin/bookings?search=${encodeURIComponent(added.reference)}`}
            className="min-h-[44px] content-center px-1 text-sm font-semibold underline"
          >
            Open in Bookings
          </Link>
        </Alert>
      ) : null}

      <div className="grid gap-3 md:grid-cols-2 md:items-start">
        {/* ── 1. What ─────────────────────────────────────────────── */}
        <Step n={1} title="What are they booking?" hint={facility?.name} done={Boolean(facility)}>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="field-label flex items-center gap-1.5">
                <MapPin className="h-3.5 w-3.5 text-ink-400" aria-hidden="true" />
                Ground
              </span>
              <select className="field-input" value={locationId} onChange={(e) => setLocationId(e.target.value)}>
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className="field-label">Service</span>
              <select className="field-input" value={facilityId} onChange={(e) => setFacilityId(e.target.value)}>
                {facilitiesHere.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
            </label>

            {(facility?.resources.length ?? 0) > 1 ? (
              <label className="block">
                <span className="field-label">Court</span>
                <select className="field-input" value={resourceId} onChange={(e) => setResourceId(e.target.value)}>
                  {facility?.resources.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}

            <label className="block">
              <span className="field-label">Date</span>
              <input
                type="date"
                className="field-input"
                value={date}
                min={today}
                onChange={(e) => setDate(e.target.value)}
              />
            </label>
          </div>

          {isOvers ? (
            <div className="mt-3 grid gap-3 rounded-lg bg-ink-50 p-3 sm:grid-cols-2">
              <label className="block">
                <span className="field-label">Ball</span>
                <select className="field-input" value={ballTypeId} onChange={(e) => setBallTypeId(e.target.value)}>
                  {facility?.ballTypes.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name} · {formatCurrency(b.pricePerSlot)} / {facility.oversPerSlot} overs
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="field-label">Overs</span>
                <select className="field-input" value={overs} onChange={(e) => setOvers(Number(e.target.value))}>
                  {Array.from({ length: 8 }, (_, i) => (facility?.oversPerSlot ?? 10) * (i + 1)).map((value) => (
                    <option key={value} value={value}>
                      {value} overs
                    </option>
                  ))}
                </select>
              </label>
            </div>
          ) : null}
        </Step>

        {/* ── 2. When ─────────────────────────────────────────────── */}
        <Step
          n={2}
          title={isOvers ? "When does the session start?" : "Which hours?"}
          hint={formatBusinessDate(date)}
          done={contiguous}
        >
          {loadingDay ? (
            <p className="flex items-center gap-2 py-3 text-sm text-ink-600">
              <Spinner /> Loading the day…
            </p>
          ) : dayError ? (
            <Alert tone="error">{dayError}</Alert>
          ) : day?.dayBlock ? (
            <Alert tone="warning">
              This ground is closed on {formatBusinessDate(date)} — {day.dayBlock.reason}. Re-open it under Availability
              first.
            </Alert>
          ) : splitByQuarter ? (
            <div className="max-h-[40dvh] space-y-1.5 overflow-y-auto pr-1 sm:max-h-[46dvh]">
              {hourGroups.map(({ hour, units: own }) => {
                const openNow = expandedHours.has(hour);
                const freeHere = own.filter(
                  (u) => u.status === "AVAILABLE" && (!isOvers || Boolean(oversRunFrom(u.startMin))),
                ).length;
                return (
                  <div key={hour} className="overflow-hidden rounded-lg border border-ink-200 bg-white">
                    <button
                      type="button"
                      onClick={() => setOpenHour(openNow ? null : hour)}
                      aria-expanded={openNow}
                      disabled={freeHere === 0}
                      className={cn(
                        "flex h-12 w-full items-center justify-between gap-2 px-3 text-sm font-semibold",
                        freeHere === 0 ? "cursor-not-allowed text-ink-400" : "text-ink-800 hover:bg-ink-50",
                      )}
                    >
                      <span>{formatCompactRange(hour, hour + 60)}</span>
                      <span className="flex items-center gap-2 text-xs font-medium text-ink-500">
                        {freeHere === 0 ? "full" : `${freeHere} free`}
                        <ChevronDown
                          className={cn("h-4 w-4 transition-transform", openNow && "rotate-180")}
                          aria-hidden="true"
                        />
                      </span>
                    </button>
                    {openNow ? (
                      <div className="grid grid-cols-2 gap-1.5 border-t border-ink-100 p-2 sm:grid-cols-4">
                        {own.map((unit) => (
                          <SlotButton key={unit.startMin} unit={unit} compact />
                        ))}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="grid max-h-[40dvh] grid-cols-3 gap-1.5 overflow-y-auto pr-1 sm:max-h-[46dvh] sm:grid-cols-4">
              {units.map((unit) => (
                <SlotButton key={unit.startMin} unit={unit} />
              ))}
            </div>
          )}

          {!isOvers && picked.length > 1 && !contiguous ? (
            <Alert tone="warning" className="mt-2">
              Pick hours that run on from each other. Two separate gaps are two bookings.
            </Alert>
          ) : null}
        </Step>

        {/* ── 3. Who ──────────────────────────────────────────────── */}
        <Step n={3} title="Who is it for?" hint={whoValid ? name.trim() : undefined} done={whoValid}>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="field-label flex items-center gap-1.5">
                <User className="h-3.5 w-3.5 text-ink-400" aria-hidden="true" />
                Customer name
              </span>
              <input
                className="field-input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoComplete="off"
                placeholder="Name they gave you"
              />
            </label>
            <label className="block">
              <span className="field-label">Mobile number</span>
              <input
                className="field-input"
                value={phone}
                inputMode="numeric"
                onChange={(e) => setPhone(e.target.value)}
                placeholder="9876543210"
                autoComplete="off"
              />
            </label>
          </div>
        </Step>

        {/* ── 4. Money ────────────────────────────────────────────── */}
        <Step
          n={4}
          title="Money"
          hint={collectedNumber > 0 ? `${formatCurrency(collectedNumber)} taken` : "Collect at the ground"}
          done
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="field-label flex items-center gap-1.5">
                <IndianRupee className="h-3.5 w-3.5 text-ink-400" aria-hidden="true" />
                Collected now
              </span>
              <input
                type="number"
                min={0}
                max={total}
                inputMode="numeric"
                className="field-input"
                value={collected}
                onChange={(e) => setCollected(e.target.value)}
              />
              <span className="mt-1 flex flex-wrap items-center gap-2 text-xs text-ink-500">
                Leave at 0 to collect at the ground.
                {total > 0 ? (
                  <button
                    type="button"
                    className="rounded-full border border-ink-200 px-2 py-0.5 font-medium text-ink-700 hover:bg-ink-100"
                    onClick={() => setCollected(String(total))}
                  >
                    Paid in full
                  </button>
                ) : null}
              </span>
            </label>
            <label className="block">
              <span className="field-label">Note (optional)</span>
              <input
                className="field-input"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Paid by UPI, regular customer…"
              />
            </label>
          </div>

          {!collectedValid ? (
            <Alert tone="warning" className="mt-3">
              Collected money cannot be more than the {formatCurrency(total)} this booking costs.
            </Alert>
          ) : null}
        </Step>

        {error ? (
          <div className="md:col-span-2">
            <Alert tone="error">{error}</Alert>
          </div>
        ) : null}
      </div>

      {/* ── What is about to be saved, and the button that saves it ── */}
      <footer className="rounded-xl border border-ink-200 bg-white px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
          <p className="min-w-0 text-sm">
            {contiguous ? (
              <>
                <span className="font-semibold text-ink-900">
                  {formatRange(selectedUnits[0]!.startMin, selectedUnits[selectedUnits.length - 1]!.endMin)}
                </span>
                <span className="text-ink-500">
                  {isOvers ? ` · ${overs} overs` : ""} · {formatBusinessDate(date)}
                </span>
              </>
            ) : (
              <span className="text-ink-500">Pick a time to see the price</span>
            )}
          </p>
          <p className="text-right">
            <span className="text-xs text-ink-500">Charged</span>{" "}
            <span className="text-lg font-bold text-ink-900">{formatCurrency(total)}</span>
          </p>
        </div>

        <div className="mt-3 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="secondary" className="h-11" disabled={saving} onClick={reset}>
            Clear
          </Button>
          <Button className="h-11 sm:min-w-44" disabled={!canSave} onClick={() => void save()}>
            {saving ? <Spinner /> : null}
            {saving ? "Adding…" : "Add booking"}
          </Button>
        </div>
      </footer>
    </div>
  );
}
