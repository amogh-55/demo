"use client";

import * as React from "react";
import { ChevronDown, ExternalLink, Image as ImageIcon, Search, SlidersHorizontal } from "lucide-react";
import { api, errorMessage } from "@/lib/client";
import { formatBusinessDate, formatIstTimestamp, formatRange, minutesToDuration } from "@/lib/time";
import { Alert, Button, EmptyState, Spinner, StatusBadge, cn, formatCurrency } from "@/components/ui/primitives";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { PaymentReviewDialog, type PaymentAttemptView } from "@/components/admin/payment-review-dialog";

interface AdminBooking {
  id: string;
  reference: string;
  locationId: string;
  locationName: string;
  date: string;
  startMin: number;
  endMin: number;
  amount: number;
  customerName: string;
  customerPhone: string;
  status: string;
  paymentVerificationStatus: string;
  amountPaid: number;
  amountRemaining: number;
  payments: PaymentAttemptView[];
  hasScreenshot: boolean;
  rejectionReason: string | null;
  createdAt: string;
}

interface ListResponse {
  bookings: AdminBooking[];
  page: number;
  totalPages: number;
  total: number;
}

type PendingAction = { kind: "CONFIRM"; booking: AdminBooking } | { kind: "REJECT"; booking: AdminBooking };

/**
 * Deliberately no payment-related reasons here. Releasing the slots is for a
 * customer who is not coming; a payment problem is handled in Review payment,
 * which keeps the reservation.
 */
const REJECT_REASONS = ["Customer cancelled", "Customer not reachable", "Duplicate booking", "Ground unavailable"];

export function BookingsManager({
  locations,
  initialFilters,
}: {
  locations: Array<{ id: string; name: string }>;
  initialFilters: { locationId?: string; date?: string; status?: string; payment?: string; search?: string };
}) {
  const [locationId, setLocationId] = React.useState(initialFilters.locationId ?? "");
  const [date, setDate] = React.useState(initialFilters.date ?? "");
  const [status, setStatus] = React.useState(initialFilters.status ?? "");
  const [payment, setPayment] = React.useState(initialFilters.payment ?? "");
  const [search, setSearch] = React.useState(initialFilters.search ?? "");
  const [page, setPage] = React.useState(1);
  const [filtersOpen, setFiltersOpen] = React.useState(false);

  const [data, setData] = React.useState<ListResponse | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [listError, setListError] = React.useState<string | null>(null);

  const [pending, setPending] = React.useState<PendingAction | null>(null);
  const [reviewing, setReviewing] = React.useState<AdminBooking | null>(null);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [actionError, setActionError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    setListError(null);
    try {
      const params = new URLSearchParams({ page: String(page) });
      if (locationId) params.set("locationId", locationId);
      if (date) params.set("date", date);
      if (status) params.set("status", status);
      if (payment) params.set("payment", payment);
      if (search.trim()) params.set("search", search.trim());
      setData(await api<ListResponse>(`/api/admin/bookings?${params.toString()}`));
    } catch (err) {
      setListError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [locationId, date, status, payment, search, page]);

  React.useEffect(() => {
    const id = window.setTimeout(() => void load(), search ? 300 : 0);
    return () => window.clearTimeout(id);
  }, [load, search]);

  React.useEffect(() => {
    setPage(1);
  }, [locationId, date, status, payment, search]);

  async function runAction(action: PendingAction, reason: string) {
    setBusyId(action.booking.id);
    setActionError(null);
    try {
      const body = action.kind === "REJECT" ? { action: "REJECT", reason } : { action: "CONFIRM" };
      await api(`/api/admin/bookings/${action.booking.id}`, { method: "PATCH", body: JSON.stringify(body) });
      setPending(null);
      setNotice(
        action.kind === "CONFIRM"
          ? `Booking ${action.booking.reference} confirmed.`
          : `Booking ${action.booking.reference} rejected and its slots released.`,
      );
      await load();
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setBusyId(null);
    }
  }

  /** Recording money never touches the slots — that is the whole point. */
  async function reviewPayment(booking: AdminBooking, body: Record<string, unknown>) {
    setBusyId(booking.id);
    setActionError(null);
    try {
      const result = await api<{ booking: AdminBooking }>(`/api/admin/bookings/${booking.id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      const remaining = result.booking.amountRemaining;
      setNotice(
        remaining > 0
          ? `${booking.reference}: ${formatCurrency(remaining)} still outstanding. The slots are still reserved.`
          : `${booking.reference}: paid in full. You can confirm the booking now.`,
      );
      setReviewing(null);
      await load();
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setBusyId(null);
    }
  }

  /** Opens WhatsApp with a pre-filled message. The admin still presses send. */
  async function openWhatsapp(booking: AdminBooking, kind: "CONFIRM" | "REJECT" | "BALANCE") {
    setBusyId(booking.id);
    setActionError(null);
    try {
      const { url } = await api<{ url: string }>(`/api/admin/bookings/${booking.id}`, {
        method: "POST",
        body: JSON.stringify({ kind, reason: booking.rejectionReason ?? undefined }),
      });
      await api(`/api/admin/bookings/${booking.id}`, {
        method: "PATCH",
        body: JSON.stringify({ action: "WHATSAPP_OPENED", kind }),
      });
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setBusyId(null);
    }
  }

  const bookings = data?.bookings ?? [];
  const activeFilters = [locationId, date, status, payment, search].filter(Boolean).length;

  return (
    <div className="space-y-4">
      {/* Filters */}
      <section className="card" aria-label="Filters">
        {/* Five stacked fields fill a phone screen, so the bookings only start below the fold. */}
        <button
          type="button"
          className="flex h-11 w-full items-center justify-between gap-2 text-sm font-semibold text-ink-800 sm:hidden"
          aria-expanded={filtersOpen}
          aria-controls="booking-filters"
          onClick={() => setFiltersOpen((open) => !open)}
        >
          <span className="flex items-center gap-2">
            <SlidersHorizontal className="h-4 w-4" aria-hidden="true" />
            Filters
            {activeFilters > 0 ? (
              <span className="rounded-full bg-pitch-600 px-2 py-0.5 text-xs font-semibold text-white">
                {activeFilters} active
              </span>
            ) : null}
          </span>
          <ChevronDown className={cn("h-4 w-4 transition-transform", filtersOpen && "rotate-180")} aria-hidden="true" />
        </button>

        <div
          id="booking-filters"
          className={cn("mt-3 grid gap-3 sm:mt-0 sm:grid-cols-2 lg:grid-cols-5", !filtersOpen && "hidden sm:grid")}
        >
          <div>
            <label className="field-label" htmlFor="filter-location">
              Location
            </label>
            <select id="filter-location" className="field-input" value={locationId} onChange={(e) => setLocationId(e.target.value)}>
              <option value="">All locations</option>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="field-label" htmlFor="filter-date">
              Date
            </label>
            <input id="filter-date" type="date" className="field-input" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div>
            <label className="field-label" htmlFor="filter-status">
              Status
            </label>
            <select id="filter-status" className="field-input" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">All statuses</option>
              <option value="PENDING">Pending</option>
              <option value="CONFIRMED">Confirmed</option>
              <option value="REJECTED">Rejected</option>
              <option value="CANCELLED">Cancelled</option>
            </select>
          </div>
          <div>
            <label className="field-label" htmlFor="filter-payment">
              Payment
            </label>
            <select id="filter-payment" className="field-input" value={payment} onChange={(e) => setPayment(e.target.value)}>
              <option value="">Any payment state</option>
              <option value="PENDING">Not verified</option>
              <option value="PARTIAL">Part paid</option>
              <option value="VERIFIED">Verified</option>
              <option value="REJECTED">Rejected</option>
            </select>
          </div>
          <div>
            <label className="field-label" htmlFor="filter-search">
              Search
            </label>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-400" aria-hidden="true" />
              <input
                id="filter-search"
                className="field-input pl-9"
                placeholder="Reference, name or phone"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
          </div>
        </div>
        {/* Outside the collapsible block so a stale filter can be cleared without expanding it. */}
        {(locationId || date || status || payment || search) && (
          <Button
            variant="ghost"
            size="sm"
            className="mt-3 h-11 w-full sm:h-9 sm:w-auto"
            onClick={() => {
              setLocationId("");
              setDate("");
              setStatus("");
              setPayment("");
              setSearch("");
            }}
          >
            Clear filters
          </Button>
        )}
      </section>

      {notice ? (
        <Alert tone="success" className="flex items-center justify-between gap-3">
          <span className="min-w-0 break-words">{notice}</span>
          <button type="button" className="h-11 shrink-0 px-2 text-xs underline" onClick={() => setNotice(null)}>
            Dismiss
          </button>
        </Alert>
      ) : null}
      {actionError ? <Alert tone="error">{actionError}</Alert> : null}
      {listError ? <Alert tone="error">{listError}</Alert> : null}

      {loading ? (
        <p className="flex items-center gap-2 py-8 text-sm text-ink-600">
          <Spinner /> Loading bookings…
        </p>
      ) : bookings.length === 0 ? (
        <EmptyState title="No bookings found." hint="Try widening the filters." />
      ) : (
        <>
          <ul className="space-y-3">
            {bookings.map((booking) => (
              <BookingCard
                key={booking.id}
                booking={booking}
                busy={busyId === booking.id}
                onAction={(kind) => {
                  setActionError(null);
                  setPending({ kind, booking } as PendingAction);
                }}
                onReview={() => {
                  setActionError(null);
                  setReviewing(booking);
                }}
                onWhatsapp={(kind) => void openWhatsapp(booking, kind)}
              />
            ))}
          </ul>

          <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
            <p className="text-sm text-ink-600">
              Page {data?.page ?? 1} of {data?.totalPages ?? 1} · {data?.total ?? 0} booking
              {(data?.total ?? 0) === 1 ? "" : "s"}
            </p>
            <div className="flex flex-1 gap-2 sm:flex-none">
              <Button
                variant="secondary"
                size="sm"
                className="h-11 flex-1 sm:h-9 sm:flex-none"
                disabled={(data?.page ?? 1) <= 1}
                onClick={() => setPage((p) => p - 1)}
              >
                Previous
              </Button>
              <Button
                variant="secondary"
                size="sm"
                className="h-11 flex-1 sm:h-9 sm:flex-none"
                disabled={(data?.page ?? 1) >= (data?.totalPages ?? 1)}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </Button>
            </div>
          </div>
        </>
      )}

      <PaymentReviewDialog
        booking={reviewing}
        open={reviewing !== null}
        onOpenChange={() => setReviewing(null)}
        busy={busyId !== null}
        error={actionError}
        onAccept={(attemptId, amount, note) =>
          reviewing && void reviewPayment(reviewing, { action: "ACCEPT_PAYMENT", attemptId, amount, note })
        }
        onReject={(attemptId, note) =>
          reviewing && void reviewPayment(reviewing, { action: "REJECT_PAYMENT", attemptId, note })
        }
        onRecord={(amount, note) => reviewing && void reviewPayment(reviewing, { action: "RECORD_PAYMENT", amount, note })}
      />

      <ConfirmDialog
        open={pending?.kind === "CONFIRM"}
        onOpenChange={() => setPending(null)}
        title="Confirm this booking?"
        description={
          pending ? (
            <>
              {pending.booking.customerName} · {formatBusinessDate(pending.booking.date)} ·{" "}
              {formatRange(pending.booking.startMin, pending.booking.endMin)}. The slots become booked and cannot be
              given to anyone else.
            </>
          ) : null
        }
        confirmLabel="Confirm booking"
        busy={busyId !== null}
        error={actionError}
        onConfirm={(reason) => pending && void runAction(pending, reason)}
      />

      <ConfirmDialog
        open={pending?.kind === "REJECT"}
        onOpenChange={() => setPending(null)}
        title="Reject and release the slots?"
        description={
          <>
            <strong>This frees the slots immediately</strong> so another customer can book them, and it cannot be undone.
            <br />
            <br />
            If the problem is only the payment — wrong amount, unclear screenshot — close this and use{" "}
            <strong>Review payment</strong> instead. That keeps the reservation while you sort it out.
          </>
        }
        reasonLabel="Reason the customer will see"
        reasonOptions={REJECT_REASONS}
        confirmLabel="Reject booking"
        confirmTone="danger"
        busy={busyId !== null}
        error={actionError}
        onConfirm={(reason) => pending && void runAction(pending, reason)}
      />
    </div>
  );
}

/** Left-edge colour so a long list can be scanned without reading every badge. */
const STATUS_ACCENT: Record<string, string> = {
  PENDING: "bg-amber-400",
  CONFIRMED: "bg-pitch-500",
  REJECTED: "bg-ink-300",
  CANCELLED: "bg-ink-300",
  EXPIRED: "bg-ink-300",
};

function BookingCard({
  booking,
  busy,
  onAction,
  onReview,
  onWhatsapp,
}: {
  booking: AdminBooking;
  busy: boolean;
  onAction: (kind: PendingAction["kind"]) => void;
  onReview: () => void;
  onWhatsapp: (kind: "CONFIRM" | "REJECT" | "BALANCE") => void;
}) {
  const isPending = booking.status === "PENDING";
  // Confirming needs the money to actually add up, not just a verified flag.
  const paidInFull = booking.paymentVerificationStatus === "VERIFIED" && booking.amountRemaining <= 0;
  const partPaid = isPending && booking.amountRemaining > 0 && booking.amountPaid > 0;

  return (
    <li className={cn("card relative overflow-hidden pl-5 sm:pl-6", busy && "opacity-70")}>
      <span
        aria-hidden="true"
        className={cn("absolute inset-y-0 left-0 w-1.5", STATUS_ACCENT[booking.status] ?? "bg-ink-300")}
      />

      {/* Stacked on a phone. Side by side, the two status pills needed most of the
          row and squeezed the name column to nothing, which wrapped it to one
          letter per line. */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-x-4">
        <div className="min-w-0 sm:flex-1">
          <p className="break-words text-lg font-semibold leading-tight text-ink-900">{booking.customerName}</p>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm text-ink-500">
            <a href={`tel:+91${booking.customerPhone}`} className="font-medium text-ink-700 hover:text-pitch-700">
              +91 {booking.customerPhone}
            </a>
            <span aria-hidden="true">·</span>
            {/* Short and meaningless if broken across lines, so it never wraps. */}
            <span className="whitespace-nowrap font-mono text-xs tracking-wide">{booking.reference}</span>
          </p>
        </div>

        {/* Two statuses that can both read "Pending" are meaningless side by side,
            so each one says what it is about. */}
        <dl className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs sm:shrink-0 sm:justify-end">
          <div className="flex items-center gap-1.5">
            <dt className="text-ink-500">Booking</dt>
            <dd>
              <StatusBadge status={booking.status} />
            </dd>
          </div>
          <div className="flex items-center gap-1.5">
            <dt className="text-ink-500">Payment</dt>
            <dd>
              <StatusBadge status={booking.paymentVerificationStatus} />
            </dd>
          </div>
        </dl>
      </div>

      {/* When and where, on one line: the owner reads these together, and the
          duration is already implied by the time range. */}
      <p className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        <span className="font-medium text-ink-900">{formatBusinessDate(booking.date)}</span>
        <span className="text-ink-300" aria-hidden="true">|</span>
        <span className="font-medium text-ink-900">{formatRange(booking.startMin, booking.endMin)}</span>
        <span className="text-ink-400">({minutesToDuration(booking.endMin - booking.startMin)})</span>
        <span className="text-ink-300" aria-hidden="true">|</span>
        <span className="min-w-0 break-words text-ink-600">{booking.locationName}</span>
      </p>

      <p className="mt-2 flex flex-wrap items-baseline gap-x-2 text-sm">
        <span className="text-base font-bold text-ink-900">{formatCurrency(booking.amount)}</span>
        {booking.amountPaid > 0 ? (
          <span className={cn("font-medium", paidInFull ? "text-green-700" : "text-amber-700")}>
            {formatCurrency(booking.amountPaid)} received
          </span>
        ) : (
          <span className="text-ink-500">nothing received yet</span>
        )}
      </p>

      {partPaid ? (
        <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm font-medium text-amber-900">
          Short by {formatCurrency(booking.amountRemaining)} — the slots are still reserved for this customer.
        </p>
      ) : null}

      {booking.rejectionReason ? (
        <p className="mt-3 text-sm text-ink-600">
          <span className="text-ink-500">Reason:</span> {booking.rejectionReason}
        </p>
      ) : null}

      {/* Stacked below sm: six short buttons wrapping on a phone read as a jumble, and
          36px-tall pills are hard to hit for an owner working one-handed. */}
      <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        {isPending && !paidInFull ? (
          <Button size="sm" className="h-11 sm:h-9" onClick={onReview} disabled={busy}>
            Review payment
          </Button>
        ) : null}

        {isPending && paidInFull ? (
          <Button size="sm" className="h-11 sm:h-9" onClick={() => onAction("CONFIRM")} disabled={busy}>
            Accept booking
          </Button>
        ) : null}

        {partPaid ? (
          <Button size="sm" variant="whatsapp" className="h-11 sm:h-9" onClick={() => onWhatsapp("BALANCE")} disabled={busy}>
            Ask for {formatCurrency(booking.amountRemaining)}
          </Button>
        ) : null}

        {booking.status === "CONFIRMED" ? (
          <Button size="sm" variant="whatsapp" className="h-11 sm:h-9" onClick={() => onWhatsapp("CONFIRM")} disabled={busy}>
            Confirm via WhatsApp
          </Button>
        ) : null}

        {booking.status === "REJECTED" ? (
          <Button size="sm" variant="whatsapp" className="h-11 sm:h-9" onClick={() => onWhatsapp("REJECT")} disabled={busy}>
            Reject via WhatsApp
          </Button>
        ) : null}

        {booking.hasScreenshot ? (
          <a href={`/api/admin/bookings/${booking.id}/screenshot`} target="_blank" rel="noopener noreferrer">
            <Button variant="secondary" size="sm" className="h-11 w-full sm:h-9 sm:w-auto">
              <ImageIcon className="h-4 w-4" aria-hidden="true" />
              Screenshot
              <ExternalLink className="h-3 w-3" aria-hidden="true" />
            </Button>
          </a>
        ) : (
          <span className="self-center text-sm text-ink-500">No screenshot uploaded</span>
        )}

        {/* Releasing someone's slots is irreversible, so it is pushed to the end and
            styled quietly. A solid red button was the loudest thing on the card and
            sat right beside the one the owner actually presses all day. */}
        {isPending ? (
          <Button
            size="sm"
            variant="secondary"
            className="h-11 border-red-200 text-red-700 hover:bg-red-50 hover:text-red-800 sm:ml-auto sm:h-9"
            onClick={() => onAction("REJECT")}
            disabled={busy}
          >
            Reject &amp; release
          </Button>
        ) : null}

        {busy ? <Spinner className="self-center text-ink-500" /> : null}
      </div>

      <p className="mt-3 border-t border-ink-100 pt-2 text-xs text-ink-400">
        Requested {formatIstTimestamp(booking.createdAt)}
      </p>
    </li>
  );
}
