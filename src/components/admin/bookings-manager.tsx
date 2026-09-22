"use client";

import * as React from "react";
import { ChevronDown, ExternalLink, Image as ImageIcon, Search, SlidersHorizontal } from "lucide-react";
import { api, errorMessage } from "@/lib/client";
import { formatBusinessDate, formatIstTimestamp, formatRange, minutesToDuration } from "@/lib/time";
import { Alert, Button, EmptyState, Spinner, StatusBadge, cn, formatCurrency } from "@/components/ui/primitives";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { PaymentReviewDialog, type PaymentAttemptView } from "@/components/admin/payment-review-dialog";
import { ManualBookingDialog, type ManualBookingFacility } from "@/components/admin/manual-booking-dialog";

interface AdminBooking {
  id: string;
  reference: string;
  locationId: string;
  locationName: string;
  facilityName: string;
  resourceName: string;
  /** Bowling-machine bookings only. */
  overs: number | null;
  ballTypeName: string | null;
  phoneVerified: boolean;
  /** Short bowling sessions: confirmed on the spot, cash due at the ground. */
  payAtVenue: boolean;
  /** Set when the owner took this booking over the phone, so it has no payment behind it. */
  createdBy: string | null;
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
  /** What the customer agreed to pay online. Below `amount` means they took the advance. */
  amountDueNow: number;
  payments: PaymentAttemptView[];
  /** UPLOADED, FAILED (our storage refused a valid image) or NONE. */
  screenshotUploadStatus: "UPLOADED" | "FAILED" | "NONE";
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
  facilities,
  today,
  initialFilters,
  initialList,
}: {
  locations: Array<{ id: string; name: string }>;
  /** Everything bookable, for the phone-booking dialog. */
  facilities: ManualBookingFacility[];
  /** Today in Asia/Kolkata, from the server — never the admin's device clock. */
  today: string;
  initialFilters: { locationId?: string; date?: string; status?: string; payment?: string; search?: string };
  /** Page one for these filters, already queried on the server. */
  initialList: ListResponse;
}) {
  const [locationId, setLocationId] = React.useState(initialFilters.locationId ?? "");
  const [date, setDate] = React.useState(initialFilters.date ?? "");
  const [status, setStatus] = React.useState(initialFilters.status ?? "");
  const [payment, setPayment] = React.useState(initialFilters.payment ?? "");
  const [search, setSearch] = React.useState(initialFilters.search ?? "");
  const [page, setPage] = React.useState(1);
  const [filtersOpen, setFiltersOpen] = React.useState(false);

  const [data, setData] = React.useState<ListResponse | null>(initialList);
  const [loading, setLoading] = React.useState(false);
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

  /**
   * The list the server already rendered is the list for the filters the page
   * was opened with, so the first run of this effect has nothing to fetch. It
   * takes over from the first filter change onwards.
   */
  const serverRendered = React.useRef(true);

  React.useEffect(() => {
    if (serverRendered.current) {
      serverRendered.current = false;
      return;
    }
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

  /**
   * Recording money never touches the slots — that is the whole point.
   *
   * `thenConfirm` accepts the booking in the same press when the payment clears
   * the bill, so the admin is not sent back to the list to find a second button.
   * It is a second request rather than one combined endpoint: if it fails the
   * money is still safely recorded and the booking simply stays pending, which is
   * exactly the state the "Accept booking" button already handles.
   */
  async function reviewPayment(booking: AdminBooking, body: Record<string, unknown>, thenConfirm = false) {
    setBusyId(booking.id);
    setActionError(null);
    try {
      const result = await api<{ booking: AdminBooking }>(`/api/admin/bookings/${booking.id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      const remaining = result.booking.amountRemaining;

      let confirmed = false;
      if (thenConfirm && remaining <= 0) {
        await api(`/api/admin/bookings/${booking.id}`, {
          method: "PATCH",
          body: JSON.stringify({ action: "CONFIRM" }),
        });
        confirmed = true;
      }

      setNotice(
        remaining > 0
          ? `${booking.reference}: ${formatCurrency(remaining)} still outstanding. The slots are still reserved.`
          : confirmed
            ? `${booking.reference}: paid in full and confirmed.`
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

  const addBooking =
    facilities.length > 0 ? (
      <ManualBookingDialog
        locations={locations}
        facilities={facilities}
        today={today}
        onCreated={(message) => {
          setActionError(null);
          setNotice(message);
          void load();
        }}
      />
    ) : null;

  return (
    <div className="space-y-4">
      {/* The title and the one thing the owner comes here to ADD share a row, so
          the button sits top-right where it is looked for. It goes full width
          under the title on a phone, where a small right-aligned button is a
          thumb-miss. */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-xl font-bold text-ink-900">Bookings</h1>
          <p className="text-sm text-ink-600">Verify payments, accept or reject requests.</p>
        </div>
        {addBooking}
      </div>
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
        onAccept={(attemptId, amount, note, confirmBooking) =>
          reviewing &&
          void reviewPayment(reviewing, { action: "ACCEPT_PAYMENT", attemptId, amount, note }, confirmBooking)
        }
        onReject={(attemptId, note) =>
          reviewing && void reviewPayment(reviewing, { action: "REJECT_PAYMENT", attemptId, note })
        }
        onRecord={(amount, note, confirmBooking, utr) =>
          reviewing && void reviewPayment(reviewing, { action: "RECORD_PAYMENT", amount, note, utr }, confirmBooking)
        }
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
  /** The reference on the most recent payment that carries one. */
  const latestUtr = [...booking.payments].reverse().find((p) => p.utr)?.utr ?? null;
  // Confirming needs the money to actually add up, not just a verified flag.
  const paidInFull = booking.paymentVerificationStatus === "VERIFIED" && booking.amountRemaining <= 0;
  const owes = booking.amountRemaining > 0;
  /*
   * The customer chose to pay part now and the rest at the ground. Worth saying
   * out loud: otherwise a ₹350 payment against a ₹700 pitch reads as someone who
   * paid too little, and staff chase a balance that was always going to be
   * collected at the gate.
   */
  const onAdvance = booking.amountDueNow < booking.amount;

  /**
   * Whether the server would accept a payment against this booking — the same
   * three cases `recordManualPayment` allows, said in the same order.
   *
   * A booking taken over the phone is CONFIRMED from the moment it is made and
   * still owes its money, so without this the owner who collects the balance at
   * the gate has nowhere at all to record it, and the booking reads PARTIAL for
   * ever.
   */
  const takesPayment =
    owes && (isPending || (booking.status === "CONFIRMED" && (booking.payAtVenue || Boolean(booking.createdBy))));

  /** What the customer actually turns up to use. */
  const service = [booking.facilityName, booking.resourceName !== booking.facilityName ? booking.resourceName : null]
    .filter(Boolean)
    .join(" · ");

  return (
    <li className={cn("card relative overflow-hidden pl-5 sm:pl-6", busy && "opacity-70")}>
      <span
        aria-hidden="true"
        className={cn("absolute inset-y-0 left-0 w-1.5", STATUS_ACCENT[booking.status] ?? "bg-ink-300")}
      />

      {/* 1. Who, and where the booking stands. */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-x-4">
        <p className="min-w-0 break-words text-lg font-semibold leading-tight text-ink-900 sm:flex-1">
          {booking.customerName}
        </p>

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

      {/* 2. What they booked, at the size it is actually asked about on the phone.
          It used to be the smallest text on the card, under the money. */}
      <p className="mt-1.5 break-words text-[15px] font-semibold text-pitch-800">
        {service || booking.locationName}
        {service ? <span className="font-normal text-ink-500"> · {booking.locationName}</span> : null}
      </p>

      {/* 3. When, and how much — the two things a decision is made on. */}
      <div className="mt-3 flex flex-wrap items-end justify-between gap-x-4 gap-y-2 rounded-lg bg-ink-50 px-3 py-2.5">
        <div className="min-w-0">
          <p className="text-[15px] font-semibold leading-tight text-ink-900">
            {formatBusinessDate(booking.date)}
          </p>
          <p className="mt-0.5 text-sm text-ink-700">
            {formatRange(booking.startMin, booking.endMin)}
            <span className="ml-1.5 text-xs text-ink-500">
              ({booking.overs !== null
                ? `${booking.overs} overs${booking.ballTypeName ? `, ${booking.ballTypeName}` : ""}`
                : minutesToDuration(booking.endMin - booking.startMin)})
            </span>
          </p>
        </div>
        <div className="shrink-0 text-right">
          <p className="text-lg font-bold leading-none text-ink-900">{formatCurrency(booking.amount)}</p>
          <p className="mt-1 text-xs font-semibold">
            {booking.amountPaid > 0 ? (
              <span className={paidInFull ? "text-green-700" : "text-amber-700"}>
                {formatCurrency(booking.amountPaid)} received
                {owes ? (
                  <span className="text-ink-500">
                    {" · "}
                    {formatCurrency(booking.amountRemaining)} {onAdvance ? "at the ground" : "due"}
                  </span>
                ) : null}
              </span>
            ) : booking.payAtVenue || booking.createdBy ? (
              // Not a payment to chase: this one was always going to be paid at the gate.
              <span className="text-amber-700">collect at the ground</span>
            ) : onAdvance ? (
              <span className="text-amber-700">advance {formatCurrency(booking.amountDueNow)} expected</span>
            ) : (
              <span className="font-normal text-ink-500">nothing received</span>
            )}
          </p>
        </div>
      </div>

      {/* 4. How to reach them, and what to search for. Quiet: needed when acting
          on the booking, not when scanning the list. */}
      <p className="mt-2.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-sm text-ink-500">
        <a href={`tel:+91${booking.customerPhone}`} className="font-medium text-ink-700 hover:text-pitch-700">
          +91 {booking.customerPhone}
        </a>
        <span aria-hidden="true">·</span>
        {/* Short and meaningless if broken across lines, so it never wraps. */}
        <span className="whitespace-nowrap font-mono text-xs tracking-wide">{booking.reference}</span>
        {booking.createdBy ? (
          <>
            <span aria-hidden="true">·</span>
            <span className="text-xs">
              by phone, taken by <span className="font-medium text-ink-700">{booking.createdBy}</span>
            </span>
          </>
        ) : null}
      </p>

      {/* The UTR, spelled out on the card: it is the first thing the owner looks
          for when matching a booking to a line in the bank statement, and asking
          them to open a dialog for it would mean opening one per booking. */}
      {latestUtr ? (
        <p className="mt-1.5 flex flex-wrap items-baseline gap-x-2 text-sm">
          <span className="text-ink-500">UTR</span>
          <span className="select-all font-mono font-semibold tracking-wide text-ink-800">{latestUtr}</span>
          {!booking.hasScreenshot ? (
            <span className="text-xs text-ink-500">(no screenshot — check the statement)</span>
          ) : null}
        </p>
      ) : null}

      {takesPayment && booking.amountPaid > 0 ? (
        <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm font-medium text-amber-900">
          Short by {formatCurrency(booking.amountRemaining)}
          {isPending ? " — the slots are still reserved for this customer." : "."}
        </p>
      ) : null}

      {/*
        The customer paid and sent an image; our storage would not take it. Said
        loudly, because the usual "no screenshot" signal here means the customer
        did not send one, and this is the opposite situation.
      */}
      {booking.screenshotUploadStatus === "FAILED" ? (
        <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2.5 text-sm text-amber-900">
          <p className="font-semibold">⚠️ Payment screenshot unavailable — verify using the UTR or bank statement.</p>
          <p className="mt-1">
            The customer sent a valid screenshot and our storage could not accept it. Nothing here has been
            verified automatically.
          </p>
          <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
            <div>
              <dt className="text-amber-800">Expected</dt>
              <dd className="font-semibold">{formatCurrency(booking.amount)}</dd>
            </div>
            <div>
              <dt className="text-amber-800">Received</dt>
              <dd className="font-semibold">
                {booking.amountPaid > 0 ? formatCurrency(booking.amountPaid) : "not yet"}
              </dd>
            </div>
            <div>
              <dt className="text-amber-800">UTR</dt>
              <dd className="select-all font-mono font-semibold">{latestUtr ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-amber-800">Payment</dt>
              <dd className="font-semibold">{booking.paymentVerificationStatus.toLowerCase()}</dd>
            </div>
          </dl>
        </div>
      ) : null}

      {booking.rejectionReason ? (
        <p className="mt-3 text-sm text-ink-600">
          <span className="text-ink-500">Reason:</span> {booking.rejectionReason}
        </p>
      ) : null}

      {/* Stacked below sm: six short buttons wrapping on a phone read as a jumble, and
          36px-tall pills are hard to hit for an owner working one-handed. */}
      <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        {takesPayment ? (
          <Button size="sm" className="h-11 sm:h-9" onClick={onReview} disabled={busy}>
            {/* A confirmed phone booking is not "under review" — the owner is
                writing down cash they have already taken. */}
            {isPending ? "Review payment" : `Record ${formatCurrency(booking.amountRemaining)} received`}
          </Button>
        ) : null}

        {isPending && paidInFull ? (
          <Button size="sm" className="h-11 sm:h-9" onClick={() => onAction("CONFIRM")} disabled={busy}>
            Accept booking
          </Button>
        ) : null}

        {takesPayment && booking.amountPaid > 0 ? (
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
        ) : null}

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
