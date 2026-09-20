"use client";

import * as React from "react";
import { api, errorMessage } from "@/lib/client";
import { formatBusinessDate, formatMinutes, formatRange } from "@/lib/time";
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
  date: string;
  dayBlock: { reason: string; blockedBy: string } | null;
  units: DayUnit[];
}

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

export function AvailabilityManager({
  locations,
  today,
}: {
  locations: Array<{ id: string; name: string }>;
  /** Today in Asia/Kolkata, from the server — never the admin's device clock. */
  today: string;
}) {
  const [locationId, setLocationId] = React.useState(locations[0]?.id ?? "");
  const [date, setDate] = React.useState(today);
  const [day, setDay] = React.useState<DayResponse | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);

  const [selected, setSelected] = React.useState<number[]>([]);
  const [dialog, setDialog] = React.useState<null | "BLOCK_SLOTS" | "BLOCK_DAY">(null);
  const [busy, setBusy] = React.useState(false);
  const [conflicts, setConflicts] = React.useState<Conflict[]>([]);
  const [pendingReason, setPendingReason] = React.useState("");

  const load = React.useCallback(async () => {
    if (!locationId || !date) return;
    setLoading(true);
    setError(null);
    setSelected([]);
    try {
      setDay(await api<DayResponse>(`/api/admin/day?locationId=${locationId}&date=${date}`));
    } catch (err) {
      setDay(null);
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [locationId, date]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const units = day?.units ?? [];
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

      const indexOf = (min: number) => units.findIndex((u) => u.startMin === min);
      const clicked = indexOf(startMin);
      if (clicked === indexOf(first) - 1) return [startMin, ...current];
      if (clicked === indexOf(last) + 1) return [...current, startMin];
      return [startMin];
    });
  }

  async function submitBlock(scope: "SLOTS" | "DAY", reason: string, force: boolean) {
    setBusy(true);
    setError(null);
    try {
      const body =
        scope === "DAY"
          ? { scope: "DAY", locationId, date, reason, force }
          : { scope: "SLOTS", locationId, date, startMin: selectedRange!.startMin, endMin: selectedRange!.endMin, reason, force };

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
          ? { scope: "DAY", locationId, date }
          : { scope: "SLOTS", locationId, date, startMin: selectedRange!.startMin, endMin: selectedRange!.endMin };
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
      <section className="card" aria-label="Choose location and date">
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
            {day?.location.name ?? "Slots"} · {formatBusinessDate(date)}
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
          <p className="mt-5 text-sm text-ink-500">No slots configured for this location.</p>
        ) : (
          <>
            <p className="mt-2 text-sm text-ink-600">Select slots to block or re-open. Confirmed bookings cannot be blocked.</p>
            <ul className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
              {units.map((unit) => {
                const isSelected = selected.includes(unit.startMin);
                return (
                  <li key={unit.startMin}>
                    <button
                      type="button"
                      aria-pressed={isSelected}
                      onClick={() => toggle(unit.startMin)}
                      className={cn(
                        "w-full rounded-lg border p-3 text-left transition-colors",
                        isSelected ? "border-pitch-600 ring-2 ring-pitch-600" : "border-ink-200 hover:bg-ink-50",
                      )}
                    >
                      {/* Two columns on a 320px phone leave no room for time and badge side by
                          side, so the badge is allowed to drop onto its own line. */}
                      <span className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
                        <span className="text-sm font-semibold text-ink-900">{formatMinutes(unit.startMin)}</span>
                        <StatusBadge status={unit.status} />
                      </span>
                      <span className="mt-1 block text-xs text-ink-500">{formatCurrency(unit.price)}</span>
                      {unit.booking ? (
                        <span className="mt-1 block truncate text-xs text-ink-600">
                          {unit.booking.customerName} · {unit.booking.reference}
                        </span>
                      ) : null}
                      {unit.blockReason ? (
                        <span className="mt-1 block truncate text-xs text-ink-600">{unit.blockReason}</span>
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>

            {selectedRange ? (
              <div className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-ink-200 bg-ink-50 p-4">
                <p className="min-w-0 text-sm font-medium text-ink-800">
                  {formatRange(selectedRange.startMin, selectedRange.endMin)} selected
                  <span className="ml-1.5 font-normal text-ink-600">
                    ({selected.length} slot{selected.length === 1 ? "" : "s"})
                  </span>
                </p>
                <div className="flex w-full gap-2 sm:w-auto">
                  <Button
                    size="sm"
                    variant="danger"
                    className="h-11 flex-1 sm:h-9 sm:flex-none"
                    onClick={() => setDialog("BLOCK_SLOTS")}
                    disabled={busy}
                  >
                    Block selected
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    className="h-11 flex-1 sm:h-9 sm:flex-none"
                    onClick={() => void unblock("SLOTS")}
                    disabled={busy}
                  >
                    Re-open selected
                  </Button>
                </div>
              </div>
            ) : null}
          </>
        )}
      </section>

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
            <>No bookings will be accepted at this location on {formatBusinessDate(date)}.</>
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
