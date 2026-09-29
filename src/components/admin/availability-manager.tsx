"use client";

import * as React from "react";
import { api, errorMessage } from "@/lib/client";
import { ChevronDown } from "lucide-react";
import { isPastSlot } from "@/lib/booking/schedule";
import { formatBusinessDate, formatCompactRange, formatRange } from "@/lib/time";
import { Alert, Button, Spinner, StatusBadge, cn, formatCurrency } from "@/components/ui/primitives";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

interface DayUnit {
  startMin: number;
  endMin: number;
  price: number;
  status: string;
  blockReason: string | null;
  holdUntil: string | null;
  booking: { id: string; reference: string; customerName: string; status: string } | null;
}

interface DayResponse {
  location: { id: string; name: string; active: boolean };
  facility: { id: string; name: string; kind: string; active: boolean };
  resource: { id: string; name: string; active: boolean };
  date: string;
  config: {
    openMin: number;
    closeMin: number;
    slotMinutes: number;
    oversPerSlot: number;
    ballTypes: Array<{ id: string; name: string; pricePerSlot: number }>;
  };
  dayBlock: { reason: string; blockedBy: string } | null;
  units: DayUnit[];
}

export interface AdminFacility {
  id: string;
  locationId: string;
  name: string;
  resources: Array<{ id: string; name: string }>;
}

/**
 * How wide a block reaches. Closing one court is routine; closing a whole ground
 * for a festival is the case the owner actually asked for, and doing that court
 * by court is where a court gets missed.
 */
type BlockScope = "RESOURCE" | "FACILITY" | "LOCATION";

interface Conflict {
  startMin: number;
  endMin: number;
  status: string;
  bookingReference: string | null;
  customerName: string | null;
}

interface BlockResponse {
  blocked: number;
  conflicts: Conflict[];
  needsConfirmation: boolean;
}

const BLOCK_REASONS = ["Tournament", "Maintenance", "Private event", "Weather"];

/**
 * Whether a slot may be picked for blocking or re-opening.
 *
 * BOOKED means a confirmed booking owns it, and the server refuses to block over
 * one under any circumstances — not even with `force`. Offering it as a choice
 * only produced a refusal after the owner had picked a reason and pressed Block,
 * so the grid says no where the answer is actually decided.
 *
 * The clock is the same argument: closing or re-opening a time that has already
 * started changes nothing, and offering it invites the owner to think it did.
 * It is read from the clock, not the status, because a slot blocked earlier
 * still says BLOCKED after its time has gone.
 */
function isSelectable(unit: DayUnit | undefined, date: string): boolean {
  return Boolean(unit) && unit!.status !== "BOOKED" && !isPastSlot(date, unit!.startMin, new Date());
}

/** A selection is all blocked slots (to re-open) or all open ones (to block) — never both. */
const isBlocked = (unit: DayUnit | undefined) => unit?.status === "BLOCKED";

/** One slot in the grid. Extracted because the flat list and the hour accordion draw the same thing. */
function SlotTile({
  unit,
  date,
  selected,
  priceLabel,
  onClick,
}: {
  unit: DayUnit;
  date: string;
  selected: boolean;
  priceLabel: string;
  onClick: () => void;
}) {
  const selectable = isSelectable(unit, date);
  const past = unit.status === "PAST" || isPastSlot(date, unit.startMin, new Date());
  return (
    <button
      type="button"
      aria-pressed={selected}
      disabled={!selectable}
      onClick={onClick}
      title={selectable ? undefined : past ? "That time has already passed" : "Confirmed bookings cannot be blocked"}
      className={cn(
        "w-full rounded-lg border p-3 text-left transition-colors",
        !selectable
          ? "cursor-not-allowed border-ink-200 bg-ink-50 opacity-70"
          : selected
            ? // Filled, not just outlined: an outline alone was easy to miss at arm's length.
              "border-pitch-600 bg-pitch-600 shadow-md ring-2 ring-pitch-600/30"
            : "border-ink-200 bg-white hover:bg-ink-50",
      )}
    >
      {/* Two columns on a 320px phone leave no room for time and badge side by
          side, so the badge is allowed to drop onto its own line. */}
      <span className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
        <span className={cn("text-sm font-semibold", selected ? "text-white" : "text-ink-900")}>
          {formatCompactRange(unit.startMin, unit.endMin)}
        </span>
        <StatusBadge status={unit.status} />
      </span>
      <span className={cn("mt-1 block text-xs", selected ? "text-pitch-50" : "text-ink-500")}>{priceLabel}</span>
      {unit.booking ? (
        <span className={cn("mt-1 block truncate text-xs", selected ? "text-pitch-50" : "text-ink-600")}>
          {unit.booking.customerName} · {unit.booking.reference}
        </span>
      ) : null}
      {unit.blockReason ? (
        <span className={cn("mt-1 block truncate text-xs", selected ? "text-pitch-50" : "text-ink-600")}>
          {unit.blockReason}
        </span>
      ) : null}
    </button>
  );
}

export function AvailabilityManager({
  locations,
  facilities,
  today,
}: {
  locations: Array<{ id: string; name: string }>;
  facilities: AdminFacility[];
  /** Today in Asia/Kolkata, from the server — never the admin's device clock. */
  today: string;
}) {
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
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);

  const [selected, setSelected] = React.useState<number[]>([]);
  const [dialog, setDialog] = React.useState<null | "BLOCK_SLOTS" | "BLOCK_DAY">(null);
  const [dayScope, setDayScope] = React.useState<BlockScope>("RESOURCE");
  const [busy, setBusy] = React.useState(false);
  const [conflicts, setConflicts] = React.useState<Conflict[]>([]);
  const [pendingReason, setPendingReason] = React.useState("");

  // Changing ground or facility must not leave the screen pointing at something
  // underneath a different one — it would load a court the admin cannot see.
  React.useEffect(() => {
    if (facilitiesHere.some((f) => f.id === facilityId)) return;
    setFacilityId(facilitiesHere[0]?.id ?? "");
  }, [facilitiesHere, facilityId]);

  React.useEffect(() => {
    if (!facility) return;
    if (facility.resources.some((r) => r.id === resourceId)) return;
    setResourceId(facility.resources[0]?.id ?? "");
  }, [facility, resourceId]);

  const load = React.useCallback(async () => {
    if (!resourceId || !date) return;
    setLoading(true);
    setError(null);
    setSelected([]);
    try {
      setDay(await api<DayResponse>(`/api/admin/day?resourceId=${resourceId}&date=${date}`));
    } catch (err) {
      setDay(null);
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [resourceId, date]);

  React.useEffect(() => {
    void load();
  }, [load]);

  // Memoised because the hour grouping below depends on it: a fresh [] on every
  // render would rebuild those groups on every render too.
  const units = React.useMemo(() => day?.units ?? [], [day]);

  /* ── How the day is drawn ──────────────────────────────────────────────
   * A quarter-hour facility produces 68 buttons for one day, which is a wall
   * rather than a list. Those are grouped into the hour people speak in and
   * only the open hour shows its quarters. An hourly facility is short enough
   * to show flat, so it still is.
   */
  const slotMinutes = day?.config?.slotMinutes ?? 60;
  const splitByQuarter = slotMinutes < 60;
  const [openHour, setOpenHour] = React.useState<number | null>(null);

  const hourGroups = React.useMemo(() => {
    const groups = new Map<number, DayUnit[]>();
    for (const unit of units) {
      const hour = Math.floor(unit.startMin / 60) * 60;
      groups.set(hour, [...(groups.get(hour) ?? []), unit]);
    }
    return [...groups.entries()].map(([hour, own]) => ({ hour, units: own }));
  }, [units]);

  /** The open hour, plus any hour holding part of the current selection. */
  const expandedHours = React.useMemo(() => {
    const hours = new Set<number>();
    if (openHour !== null) hours.add(openHour);
    for (const startMin of selected) hours.add(Math.floor(startMin / 60) * 60);
    return hours;
  }, [openHour, selected]);

  /**
   * What one unit costs, said in the way the facility is actually sold.
   *
   * An OVERS facility prices every unit at 0 and puts the money on the ball
   * type, so the raw number is a true and completely useless "₹0". The owner
   * needs to see what a block of overs costs them to sell.
   */
  const priceLabel = React.useCallback(
    (unit: DayUnit): string => {
      const balls = day?.config?.ballTypes ?? [];
      if (day?.facility.kind !== "OVERS" || balls.length === 0) return formatCurrency(unit.price);
      const overs = day.config.oversPerSlot || 0;
      const cheapest = Math.min(...balls.map((b) => b.pricePerSlot));
      const dearest = Math.max(...balls.map((b) => b.pricePerSlot));
      const money = cheapest === dearest ? formatCurrency(cheapest) : `${formatCurrency(cheapest)}–${formatCurrency(dearest)}`;
      return overs > 0 ? `${money} / ${overs} overs` : money;
    },
    [day],
  );

  const selectedRange =
    selected.length > 0
      ? {
          startMin: Math.min(...selected),
          endMin: Math.max(...selected.map((s) => units.find((u) => u.startMin === s)?.endMin ?? s)),
        }
      : null;

  /**
   * The block API takes a RANGE, so the selection has to be one. Allowing gaps
   * meant that picking 6 AM and 10 AM blocked 6–11: five hours closed with only
   * two highlighted. Selection is therefore contiguous by construction, and a
   * click that would leave a gap starts a fresh selection instead.
   */
  function toggle(startMin: number) {
    // A confirmed booking can never be blocked over, so it is not selectable.
    // Letting it be picked only moved the refusal to the confirmation dialog,
    // after the owner had already chosen a reason and pressed Block.
    const unit = units.find((u) => u.startMin === startMin);
    if (!unit || !isSelectable(unit, date)) return;
    setSelected((current) => {
      if (current.length === 0) return [startMin];

      const first = current[0]!;
      const last = current[current.length - 1]!;
      if (current.includes(startMin)) {
        // Only the ends can be dropped without punching a hole in the middle.
        if (startMin === first) return current.slice(1);
        if (startMin === last) return current.slice(0, -1);
        return [startMin];
      }

      // Blocked and open slots never share a selection: one button would block
      // some and re-open others. Tapping the other kind starts over from it.
      if (isBlocked(unit) !== isBlocked(units.find((u) => u.startMin === first))) return [startMin];

      // Next to the selection in time, not just in the list: with the night
      // closed from 2 to 6 AM, 1:45 AM and 6 AM sit side by side in the list.
      const lastUnit = units.find((u) => u.startMin === last);
      if (unit.endMin === first) return [startMin, ...current];
      if (lastUnit && startMin === lastUnit.endMin) return [...current, startMin];
      return [startMin];
    });
  }

  /** Whether the selection is blocked slots, so its one action is Re-open rather than Block. */
  const reopening = isBlocked(units.find((u) => u.startMin === selected[0]));

  /** Exactly one id — the server expands a facility or ground into its courts. */
  const target = (scope: BlockScope) =>
    scope === "LOCATION" ? { locationId } : scope === "FACILITY" ? { facilityId } : { resourceId };

  async function submitBlock(scope: "SLOTS" | "DAY", reason: string, force: boolean) {
    setBusy(true);
    setError(null);
    try {
      const body =
        scope === "DAY"
          ? { scope: "DAY", ...target(dayScope), date, reason, force }
          : {
              scope: "SLOTS",
              ...target("RESOURCE"),
              date,
              startMin: selectedRange!.startMin,
              endMin: selectedRange!.endMin,
              reason,
              force,
            };

      const result = await api<BlockResponse>("/api/admin/blocks", { method: "POST", body: JSON.stringify(body) });

      if (result.needsConfirmation) {
        // Existing holds or pending requests sit in this range — show them and ask again.
        setConflicts(result.conflicts);
        setPendingReason(reason);
        setBusy(false);
        return;
      }

      setDialog(null);
      setConflicts([]);
      setNotice(scope === "DAY" ? "Day blocked." : `${result.blocked} slot${result.blocked === 1 ? "" : "s"} blocked.`);
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function unblock(scope: "SLOTS" | "DAY") {
    setBusy(true);
    setError(null);
    try {
      const body =
        scope === "DAY"
          ? { scope: "DAY", ...target("RESOURCE"), date }
          : {
              scope: "SLOTS",
              ...target("RESOURCE"),
              date,
              startMin: selectedRange!.startMin,
              endMin: selectedRange!.endMin,
            };
      await api("/api/admin/blocks", { method: "DELETE", body: JSON.stringify(body) });
      setNotice(scope === "DAY" ? "Day re-opened." : "Slots re-opened.");
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <section className="card" aria-label="Choose what to manage">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="field-label" htmlFor="avail-location">
              Location
            </label>
            <select id="avail-location" className="field-input" value={locationId} onChange={(e) => setLocationId(e.target.value)}>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="field-label" htmlFor="avail-facility">
              Facility
            </label>
            <select
              id="avail-facility"
              className="field-input"
              value={facilityId}
              onChange={(e) => setFacilityId(e.target.value)}
              disabled={facilitiesHere.length === 0}
            >
              {facilitiesHere.length === 0 ? <option value="">Nothing set up here</option> : null}
              {facilitiesHere.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </div>
          {/* Only when there is a real choice: a facility with one machine should
              not make the owner pick it every time. */}
          {facility && facility.resources.length > 1 ? (
            <div>
              <label className="field-label" htmlFor="avail-resource">
                Court / pitch
              </label>
              <select
                id="avail-resource"
                className="field-input"
                value={resourceId}
                onChange={(e) => setResourceId(e.target.value)}
              >
                {facility.resources.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
              <p className="mt-1.5 text-xs text-ink-500">Each court is blocked separately.</p>
            </div>
          ) : null}
          <div>
            <label className="field-label" htmlFor="avail-date">
              Date
            </label>
            <input
              id="avail-date"
              type="date"
              className="field-input"
              value={date}
              // A day that has gone cannot be blocked, so it is not offered. No
              // upper bound: a tournament may be blocked months ahead, further
              // out than customers can book.
              min={today}
              // `min` is only a hint — the iOS wheel picker scrolls straight past
              // it — so the clamp has to be real. ISO dates compare as strings.
              onChange={(e) => {
                const picked = e.target.value;
                setDate(!picked || picked < today ? today : picked);
              }}
            />
            <p className="mt-1.5 text-xs text-ink-500">Today onwards — a day that has passed cannot be blocked.</p>
          </div>
        </div>
      </section>

      {notice ? (
        <Alert tone="success" className="flex items-center justify-between gap-3">
          <span className="min-w-0 break-words">{notice}</span>
          <button type="button" className="h-11 shrink-0 px-2 text-xs underline" onClick={() => setNotice(null)}>
            Dismiss
          </button>
        </Alert>
      ) : null}
      {error ? <Alert tone="error">{error}</Alert> : null}

      {day?.dayBlock ? (
        <Alert tone="warning" className="flex flex-wrap items-center justify-between gap-3">
          <span className="min-w-0 break-words">
            <strong>{formatBusinessDate(date)} is closed.</strong> Reason: {day.dayBlock.reason}
          </span>
          <Button size="sm" className="h-11 w-full sm:h-9 sm:w-auto" onClick={() => void unblock("DAY")} disabled={busy}>
            Re-open this day
          </Button>
        </Alert>
      ) : null}

      <section className="card">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="min-w-0 break-words font-semibold text-ink-900">
            {day
              ? `${day.facility.name}${day.facility.name === day.resource.name ? "" : ` · ${day.resource.name}`} · ${day.location.name}`
              : "Slots"}
            {" · "}
            {formatBusinessDate(date)}
          </h2>
          <div className="flex w-full gap-2 sm:w-auto">
            <Button
              size="sm"
              variant="secondary"
              className="h-11 flex-1 sm:h-9 sm:flex-none"
              onClick={() => void load()}
              disabled={loading}
            >
              Refresh
            </Button>
            {!day?.dayBlock ? (
              <Button
                size="sm"
                variant="danger"
                className="h-11 flex-1 sm:h-9 sm:flex-none"
                onClick={() => setDialog("BLOCK_DAY")}
                disabled={busy || loading}
              >
                Block whole day
              </Button>
            ) : null}
          </div>
        </div>

        {loading ? (
          <p className="mt-5 flex items-center gap-2 text-sm text-ink-600">
            <Spinner /> Loading slots…
          </p>
        ) : units.length === 0 ? (
          <p className="mt-5 text-sm text-ink-500">No slots configured for this facility.</p>
        ) : (
          <>
            <p className="mt-2 text-sm text-ink-600">
              Tap open slots to block them, or blocked slots to re-open them. Past times and confirmed bookings are
              greyed out and cannot be picked.
            </p>
            {splitByQuarter ? (
              /* A bowling machine sells quarter-hours, so a day is 68 buttons. Grouped
                 by the hour people actually speak in, with only the open hour showing
                 its quarters — the same shape the phone-booking dialog uses. */
              <div className="mt-4 space-y-1.5">
                {hourGroups.map(({ hour, units: own }) => {
                  const openNow = expandedHours.has(hour);
                  const free = own.filter((u) => u.status === "AVAILABLE").length;
                  const selectedHere = own.filter((u) => selected.includes(u.startMin)).length;
                  return (
                    <div key={hour} className="overflow-hidden rounded-lg border border-ink-200 bg-white">
                      <button
                        type="button"
                        onClick={() => setOpenHour(openNow && selectedHere === 0 ? null : hour)}
                        aria-expanded={openNow}
                        className="flex h-12 w-full items-center justify-between gap-2 px-3 text-sm font-semibold text-ink-800 hover:bg-ink-50"
                      >
                        <span>{formatCompactRange(hour, hour + 60)}</span>
                        <span className="flex items-center gap-2 text-xs font-medium text-ink-500">
                          {selectedHere > 0 ? (
                            <span className="rounded-full bg-pitch-600 px-2 py-0.5 text-white">
                              {selectedHere} picked
                            </span>
                          ) : null}
                          {free === own.length ? "all free" : free === 0 ? "none free" : `${free} of ${own.length} free`}
                          <ChevronDown
                            className={cn("h-4 w-4 transition-transform", openNow && "rotate-180")}
                            aria-hidden="true"
                          />
                        </span>
                      </button>
                      {openNow ? (
                        <ul className="grid grid-cols-2 gap-1.5 border-t border-ink-100 p-2 sm:grid-cols-4">
                          {own.map((unit) => (
                            <li key={unit.startMin}>
                              <SlotTile
                                unit={unit}
                                date={date}
                                selected={selected.includes(unit.startMin)}
                                priceLabel={priceLabel(unit)}
                                onClick={() => toggle(unit.startMin)}
                              />
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ) : (
              <ul className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
                {units.map((unit) => (
                  <li key={unit.startMin}>
                    <SlotTile
                      unit={unit}
                      date={date}
                      selected={selected.includes(unit.startMin)}
                      priceLabel={priceLabel(unit)}
                      onClick={() => toggle(unit.startMin)}
                    />
                  </li>
                ))}
              </ul>
            )}

            {/* Room under the last row, so the floating bar never covers it. */}
            {selectedRange ? <div className="h-20" aria-hidden="true" /> : null}
          </>
        )}
      </section>

      {/* The action floats with the selection, the way the customer's Continue
          does: after scrolling down to 9 PM the owner should not have to hunt for
          the button. One action only — Block for open slots, Re-open for blocked
          ones — because that is all a selection can be. */}
      {selectedRange ? (
        <div className="fixed inset-x-0 bottom-[calc(4.75rem+env(safe-area-inset-bottom))] z-30 px-3 lg:bottom-4 lg:left-60">
          <div className="mx-auto flex max-w-3xl items-center gap-2 rounded-full border border-ink-200 bg-white py-2 pl-5 pr-2 shadow-[0_8px_30px_rgba(0,0,0,0.18)]">
            <p className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold text-ink-900">
                {formatRange(selectedRange.startMin, selectedRange.endMin)}
              </span>
              <span className="block text-xs text-ink-500">
                {selected.length} {reopening ? "blocked " : ""}slot{selected.length === 1 ? "" : "s"}
              </span>
            </p>
            <button
              type="button"
              onClick={() => setSelected([])}
              disabled={busy}
              className="h-11 shrink-0 rounded-full px-3 text-sm font-medium text-ink-600 hover:bg-ink-100"
            >
              Clear
            </button>
            {reopening ? (
              <Button className="h-11 shrink-0 rounded-full px-5" onClick={() => void unblock("SLOTS")} disabled={busy}>
                {busy ? <Spinner /> : null}
                Re-open
              </Button>
            ) : (
              <Button
                variant="danger"
                className="h-11 shrink-0 rounded-full px-5"
                onClick={() => setDialog("BLOCK_SLOTS")}
                disabled={busy}
              >
                Block
              </Button>
            )}
          </div>
        </div>
      ) : null}

      <ConfirmDialog
        open={dialog === "BLOCK_SLOTS"}
        onOpenChange={() => {
          setDialog(null);
          setConflicts([]);
        }}
        title={conflicts.length ? "These slots are in use" : "Block these slots?"}
        description={
          conflicts.length ? (
            <ConflictList conflicts={conflicts} />
          ) : selectedRange ? (
            <>Customers will not be able to book {formatRange(selectedRange.startMin, selectedRange.endMin)} on {formatBusinessDate(date)}.</>
          ) : null
        }
        reasonLabel={conflicts.length ? undefined : "Reason"}
        reasonOptions={BLOCK_REASONS}
        confirmLabel={conflicts.length ? "Block anyway" : "Block slots"}
        confirmTone="danger"
        busy={busy}
        error={error}
        onConfirm={(reason) => void submitBlock("SLOTS", conflicts.length ? pendingReason : reason, conflicts.length > 0)}
      />

      <ConfirmDialog
        open={dialog === "BLOCK_DAY"}
        onOpenChange={() => {
          setDialog(null);
          setConflicts([]);
        }}
        title={conflicts.length ? "This day has active requests" : "Block the whole day?"}
        description={
          conflicts.length ? (
            <ConflictList conflicts={conflicts} />
          ) : (
            <div className="space-y-3">
              <div>
                <label className="field-label" htmlFor="day-scope">
                  What should close?
                </label>
                <select
                  id="day-scope"
                  className="field-input"
                  value={dayScope}
                  onChange={(e) => setDayScope(e.target.value as BlockScope)}
                >
                  <option value="RESOURCE">
                    {facility && facility.resources.length > 1
                      ? `Only ${day?.resource.name ?? "this court"}`
                      : `Only ${day?.facility.name ?? "this facility"}`}
                  </option>
                  {facility && facility.resources.length > 1 ? (
                    <option value="FACILITY">All of {facility.name}</option>
                  ) : null}
                  <option value="LOCATION">Everything at {day?.location.name ?? "this ground"}</option>
                </select>
              </div>
              <p>
                No bookings will be accepted for{" "}
                {dayScope === "LOCATION"
                  ? "any facility at this ground"
                  : dayScope === "FACILITY"
                    ? `any ${facility?.name ?? "court"}`
                    : "this one"}{" "}
                on {formatBusinessDate(date)}.
              </p>
            </div>
          )
        }
        reasonLabel={conflicts.length ? undefined : "Reason"}
        reasonOptions={BLOCK_REASONS}
        confirmLabel={conflicts.length ? "Block anyway" : "Block day"}
        confirmTone="danger"
        busy={busy}
        error={error}
        onConfirm={(reason) => void submitBlock("DAY", conflicts.length ? pendingReason : reason, conflicts.length > 0)}
      />
    </div>
  );
}

function ConflictList({ conflicts }: { conflicts: Conflict[] }) {
  return (
    <>
      <p className="font-medium text-amber-900">
        Blocking will cancel {conflicts.length} active hold{conflicts.length === 1 ? "" : "s"} or pending request
        {conflicts.length === 1 ? "" : "s"}:
      </p>
      {/* Whose booking is about to be cancelled is the whole point of this list, so it is
          not shrunk to the fine-print size the rest of the note uses. */}
      <ul className="mt-2 space-y-1 text-sm">
        {conflicts.map((c) => (
          <li key={c.startMin} className="flex flex-wrap justify-between gap-x-3 rounded bg-ink-50 px-2 py-1">
            <span className="shrink-0">{formatRange(c.startMin, c.endMin)}</span>
            <span className="min-w-0 break-words text-ink-600">
              {c.customerName ? `${c.customerName} · ${c.bookingReference}` : "Held by a customer"}
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-ink-600">
        Affected customers will be marked as rejected so you can message them. Confirmed bookings are never blocked.
      </p>
    </>
  );
}
