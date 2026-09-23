"use client";

import * as React from "react";
import {
  CalendarDays,
  ChevronDown,
  ExternalLink,
  Image as ImageIcon,
  Search,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { api, errorMessage } from "@/lib/client";
import { formatBusinessDate, formatIstTimestamp, formatRange, minutesToDuration } from "@/lib/time";
import { Alert, Button, EmptyState, Spinner, StatusBadge, cn, formatCurrency } from "@/components/ui/primitives";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { PaymentReviewDialog, type PaymentAttemptView } from "@/components/admin/payment-review-dialog";
import { ManualBookingDialog, type ManualBookingFacility } from "@/components/admin/manual-booking-dialog";
import { BOOKING_TABS, type BookingTab } from "@/lib/types";

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
  /** RAZORPAY settles itself; UPI_MANUAL needs an admin to look at a screenshot. */
  paymentMethod: "UPI_MANUAL" | "RAZORPAY" | null;
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
  /** How many sit behind each tab, for the counts on the pills. */
  counts?: Record<BookingTab, number>;
}

type PendingAction =
  | { kind: "CONFIRM"; booking: AdminBooking }
  | { kind: "REJECT"; booking: AdminBooking }
  /** The balance an advance customer hands over on arrival. One press, one confirm. */
  | { kind: "SETTLE_BALANCE"; booking: AdminBooking };

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
  initialFilters: { locationId?: string; date?: string; tab?: string; status?: string; payment?: string; search?: string };
  /** Page one for these filters, already queried on the server. */
  initialList: ListResponse;
}) {
  const [locationId, setLocationId] = React.useState(initialFilters.locationId ?? "");
  const [date, setDate] = React.useState(initialFilters.date ?? "");
  const [tab, setTab] = React.useState<BookingTab>((initialFilters.tab as BookingTab) ?? "all");
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
      if (tab !== "all") params.set("tab", tab);
      if (search.trim()) params.set("search", search.trim());
      setData(await api<ListResponse>(`/api/admin/bookings?${params.toString()}`));
    } catch (err) {
      setListError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [locationId, date, tab, search, page]);

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
  }, [locationId, date, tab, search]);

  async function runAction(action: PendingAction, reason: string) {
    setBusyId(action.booking.id);
    setActionError(null);
    try {
      if (action.kind === "SETTLE_BALANCE") {
        // The amount is the booking's own outstanding figure, not anything typed.
        await api(`/api/admin/bookings/${action.booking.id}`, {
          method: "PATCH",
          body: JSON.stringify({
            action: "RECORD_PAYMENT",
            amount: action.booking.amountRemaining,
            note: "Balance collected at the ground",
          }),
        });
        setPending(null);
        setNotice(`Booking ${action.booking.reference} is now paid in full.`);
        await load();
        return;
      }

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
      /*
       * What had to arrive for the slot to be the customer's. On an advance
       * booking that is the advance — waiting for the balance would leave a
       * booking the owner has agreed to take sitting as "pending" until the
       * customer turns up, which is the wrong way round.
       */
      const due = result.booking.amountDueNow;
      const settled = result.booking.amountPaid >= due;
      const atGround = Math.max(0, result.booking.amount - result.booking.amountPaid);

      let confirmed = false;
      if (thenConfirm && settled) {
        await api(`/api/admin/bookings/${booking.id}`, {
          method: "PATCH",
          body: JSON.stringify({ action: "CONFIRM" }),
        });
        confirmed = true;
      }

      setNotice(
        !settled
          ? `${booking.reference}: ${formatCurrency(due - result.booking.amountPaid)} of the amount due is still outstanding. The slots are still reserved.`
          : remaining > 0
            ? `${booking.reference}: advance received${confirmed ? " and booking confirmed" : ""}. ${formatCurrency(atGround)} to collect at the ground.`
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
  /** Only the ones hidden behind "More filters" — the tabs and search speak for themselves. */
  const hiddenFilters = [locationId, date].filter(Boolean).length;
  const counts = data?.counts;

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
      {/*
        Search first, tabs second, everything else folded away.

        The old bar put five equal dropdowns behind a "Filters" toggle, so on a
        phone the screen opened with a collapsed grey box and no bookings above
        the fold — and finding one by name meant expanding a panel first. The two
        controls that are used constantly are now always on screen; location and
        date, which are used occasionally, are the ones that fold.
      */}
      <section className="space-y-3" aria-label="Find bookings">
        <div className="relative">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-400"
            aria-hidden="true"
          />
          <input
            id="filter-search"
            className="field-input h-12 pl-10 pr-10 text-base"
            placeholder="Search name, phone, reference or UTR"
            aria-label="Search bookings"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {search ? (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => setSearch("")}
              className="absolute right-1 top-1/2 grid h-10 w-10 -translate-y-1/2 place-items-center rounded-full text-ink-400 hover:bg-ink-100 hover:text-ink-700"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          ) : null}
        </div>

        {/* Scrolls sideways rather than wrapping: five wrapped pills push the first
            booking off a phone screen, which is the problem this replaced. The
            fade on the right edge is what says there is more to scroll to —
            without it the strip just looks clipped. */}
        <div className="relative -mx-4 sm:mx-0">
          <div
            role="tablist"
            aria-label="Booking status"
            className="flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] sm:px-0 [&::-webkit-scrollbar]:hidden"
          >
            {BOOKING_TABS.map((t) => {
              const on = tab === t.id;
              const n = counts?.[t.id];
              return (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  aria-selected={on}
                  onClick={() => setTab(t.id)}
                  className={cn(
                    "flex h-10 shrink-0 items-center gap-1.5 rounded-full border px-3.5 text-sm font-medium transition-colors",
                    on
                      ? "border-pitch-600 bg-pitch-600 text-white shadow-sm"
                      : "border-ink-200 bg-white text-ink-600 hover:bg-ink-50",
                  )}
                >
                  {t.label}
                  {/* The count is the point of the tab: "To verify 4" is a to-do list. */}
                  {typeof n === "number" ? (
                    <span
                      className={cn(
                        "rounded-full px-1.5 py-0.5 text-xs font-semibold tabular-nums",
                        on ? "bg-white/20 text-white" : "bg-ink-100 text-ink-600",
                      )}
                    >
                      {n}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-ink-50 to-transparent sm:hidden"
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="flex h-10 items-center gap-2 rounded-lg border border-ink-200 bg-white px-3 text-sm font-medium text-ink-700 hover:bg-ink-50"
            aria-expanded={filtersOpen}
            aria-controls="booking-filters"
            onClick={() => setFiltersOpen((open) => !open)}
          >
            <SlidersHorizontal className="h-4 w-4" aria-hidden="true" />
            Ground &amp; date
            {hiddenFilters > 0 ? (
              <span className="rounded-full bg-pitch-600 px-1.5 py-0.5 text-xs font-semibold text-white">
                {hiddenFilters}
              </span>
            ) : null}
            <ChevronDown className={cn("h-4 w-4 transition-transform", filtersOpen && "rotate-180")} aria-hidden="true" />
          </button>

          {/* Outside the fold, so a filter left on last week can be cleared without
              first remembering where it was set. */}
          {hiddenFilters > 0 || search ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-10"
              onClick={() => {
                setLocationId("");
                setDate("");
                setSearch("");
              }}
            >
              Clear
            </Button>
          ) : null}
        </div>

        <div id="booking-filters" className={cn("grid gap-3 sm:grid-cols-2", !filtersOpen && "hidden")}>
          <div>
            <label className="field-label" htmlFor="filter-location">
              Ground
            </label>
            <select
              id="filter-location"
              className="field-input"
              value={locationId}
              onChange={(e) => setLocationId(e.target.value)}
            >
              <option value="">All grounds</option>
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
            <input
              id="filter-date"
              type="date"
              className="field-input"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
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
        open={pending?.kind === "SETTLE_BALANCE"}
        onOpenChange={() => setPending(null)}
        title="Collect the rest of the payment?"
        description={
          pending ? (
            <>
              {pending.booking.customerName} paid {formatCurrency(pending.booking.amountPaid)} online and owes{" "}
              <strong>{formatCurrency(pending.booking.amountRemaining)}</strong> at the ground.
              <br />
              <br />
              Only press this once the money is actually in your hand. It records the balance and marks the booking{" "}
              <strong>paid in full</strong>.
            </>
          ) : null
        }
        confirmLabel={pending ? `Record ${formatCurrency(pending.booking.amountRemaining)}` : "Record balance"}
        busy={busyId !== null}
        error={actionError}
        onConfirm={() => pending && void runAction(pending, "")}
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

/**
 * Where a booking's money stands, in one sentence and one colour.
 *
 * The old card worked this out inline across four separate conditionals that had
 * drifted apart — one of them called an agreed advance a shortfall. Deciding it
 * once, here, is what stops the badge, the figure and the button disagreeing.
 */
function paymentSummary(b: AdminBooking): { tone: "paid" | "advance" | "short" | "waiting" | "dead"; line: string } {
  const atGround = b.amountRemaining;
  /** What had to arrive ONLINE. Below it is short; at it is the deal being kept. */
  const metDue = b.amountPaid >= b.amountDueNow;
  const onAdvance = b.amountDueNow < b.amount;
  const dead = b.status === "REJECTED" || b.status === "CANCELLED" || b.status === "EXPIRED";

  if (dead) {
    return {
      tone: "dead",
      line: b.amountPaid > 0 ? `${formatCurrency(b.amountPaid)} received — may need refunding` : "Slots released",
    };
  }
  if (atGround <= 0) return { tone: "paid", line: "Paid in full" };
  if (b.payAtVenue || b.createdBy) {
    return { tone: "advance", line: `${formatCurrency(atGround)} to collect at the ground` };
  }
  if (b.amountPaid > 0 && metDue && onAdvance) {
    return { tone: "advance", line: `Advance paid · ${formatCurrency(atGround)} at the ground` };
  }
  if (b.amountPaid > 0) {
    return {
      tone: "short",
      line: `${formatCurrency(b.amountPaid)} received · short by ${formatCurrency(b.amountDueNow - b.amountPaid)}`,
    };
  }
  if (b.paymentMethod === "RAZORPAY") return { tone: "waiting", line: "Waiting for the online payment" };
  return { tone: "waiting", line: onAdvance ? `Advance of ${formatCurrency(b.amountDueNow)} expected` : "Nothing received yet" };
}

const PAYMENT_TONE: Record<string, string> = {
  paid: "border-green-200 bg-green-50 text-green-900",
  advance: "border-green-200 bg-green-50 text-green-900",
  short: "border-amber-200 bg-amber-50 text-amber-900",
  waiting: "border-ink-200 bg-ink-50 text-ink-700",
  dead: "border-ink-200 bg-ink-50 text-ink-600",
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
  const paidInFull = booking.paymentVerificationStatus === "VERIFIED" && booking.amountRemaining <= 0;
  const owes = booking.amountRemaining > 0;
  const onAdvance = booking.amountDueNow < booking.amount;
  const metWhatWasDue = booking.amountPaid >= booking.amountDueNow;
  const gateway = booking.paymentMethod === "RAZORPAY";

  /**
   * Whether the server would accept a payment against this booking — the same
   * cases `recordManualPayment` allows, said in the same order.
   */
  const takesPayment =
    owes && (isPending || (booking.status === "CONFIRMED" && (booking.payAtVenue || Boolean(booking.createdBy))));

  const money = paymentSummary(booking);
  const methodLabel = booking.createdBy
    ? "Phone"
    : booking.payAtVenue
      ? "At ground"
      : gateway
        ? "Razorpay"
        : "UPI screenshot";

  /** What the customer actually turns up to use. */
  const service = [booking.facilityName, booking.resourceName !== booking.facilityName ? booking.resourceName : null]
    .filter(Boolean)
    .join(" · ");

  /** The balance an advance customer hands over — one press, not a review dialog. */
  const collectsBalance = booking.amountRemaining > 0 && onAdvance && metWhatWasDue;

  return (
    <li className={cn("card relative overflow-hidden p-4 pl-5", busy && "opacity-70")}>
      <span
        aria-hidden="true"
        className={cn("absolute inset-y-0 left-0 w-1.5", STATUS_ACCENT[booking.status] ?? "bg-ink-300")}
      />

      {/* 1. Who — name, how to reach them, and where the booking stands. */}
      <div className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-pitch-50 text-sm font-bold uppercase text-pitch-700"
        >
          {booking.customerName.trim().charAt(0) || "?"}
        </span>

        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] font-semibold leading-tight text-ink-900">{booking.customerName}</p>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-ink-500">
            <a href={`tel:+91${booking.customerPhone}`} className="font-medium text-ink-600 hover:text-pitch-700">
              +91 {booking.customerPhone}
            </a>
            <span aria-hidden="true">·</span>
            <span className="whitespace-nowrap font-mono tracking-wide">{booking.reference}</span>
          </p>
        </div>

        <div className="flex shrink-0 flex-col items-end gap-1">
          <StatusBadge status={booking.status} />
          <span className="rounded-full bg-ink-100 px-2 py-0.5 text-[11px] font-medium text-ink-600">
            {methodLabel}
          </span>
        </div>
      </div>

      {/* 2. What and when, on one line each. The two things asked about on the phone. */}
      <p className="mt-3 truncate text-sm font-semibold text-pitch-800">
        {service || booking.locationName}
        {service ? <span className="font-normal text-ink-500"> · {booking.locationName}</span> : null}
      </p>
      <p className="mt-1 flex items-center gap-1.5 text-sm text-ink-700">
        <CalendarDays className="h-3.5 w-3.5 shrink-0 text-ink-400" aria-hidden="true" />
        <span className="font-medium">{formatBusinessDate(booking.date)}</span>
        <span className="text-ink-400">·</span>
        {formatRange(booking.startMin, booking.endMin)}
        <span className="text-xs text-ink-500">
          (
          {booking.overs !== null
            ? `${booking.overs} overs${booking.ballTypeName ? `, ${booking.ballTypeName}` : ""}`
            : minutesToDuration(booking.endMin - booking.startMin)}
          )
        </span>
      </p>

      {/* 3. The money, as one strip whose colour says whether anything is owed. */}
      <div
        className={cn(
          "mt-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-lg border px-3 py-2",
          PAYMENT_TONE[money.tone],
        )}
      >
        <span className="min-w-0 text-sm font-medium">{money.line}</span>
        <span className="shrink-0 text-base font-bold tabular-nums">{formatCurrency(booking.amount)}</span>
      </div>

      {/* The UTR, spelled out: it is the first thing the owner looks for when
          matching a booking to a line in the bank statement. */}
      {latestUtr ? (
        <p className="mt-2 flex flex-wrap items-baseline gap-x-2 text-xs">
          <span className="text-ink-500">UTR</span>
          <span className="select-all font-mono font-semibold tracking-wide text-ink-800">{latestUtr}</span>
          {!booking.hasScreenshot && !gateway ? (
            <span className="text-ink-500">(no screenshot — check the statement)</span>
          ) : null}
        </p>
      ) : null}

      {/*
        The customer paid and sent an image; our storage would not take it. Said
        loudly, because the usual "no screenshot" signal means the customer did
        not send one, and this is the opposite situation.
      */}
      {booking.screenshotUploadStatus === "FAILED" ? (
        <p className="mt-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          <span className="font-semibold">⚠️ Screenshot unavailable</span> — the customer sent a valid one and our
          storage refused it. Verify against the UTR or the bank statement.
        </p>
      ) : null}

      {booking.rejectionReason ? (
        <p className="mt-2 text-xs text-ink-600">
          <span className="text-ink-500">Reason:</span> {booking.rejectionReason}
        </p>
      ) : null}

      {/* 4. What to do about it. Two per row on a phone rather than a stack of
             full-width bars, which pushed the next booking off the screen. */}
      <div className="mt-3 flex flex-wrap gap-2">
        {takesPayment && !collectsBalance ? (
          <Button size="sm" className="h-10 flex-1 sm:h-9 sm:flex-none" onClick={onReview} disabled={busy}>
            {/* A confirmed phone booking is not "under review" — the owner is
                writing down cash they have already taken. */}
            {isPending ? "Review payment" : `Record ${formatCurrency(booking.amountRemaining)}`}
          </Button>
        ) : null}

        {collectsBalance ? (
          <Button size="sm" className="h-10 flex-1 sm:h-9 sm:flex-none" onClick={() => onAction("SETTLE_BALANCE")} disabled={busy}>
            Record {formatCurrency(booking.amountRemaining)}
          </Button>
        ) : null}

        {isPending && paidInFull ? (
          <Button size="sm" className="h-10 flex-1 sm:h-9 sm:flex-none" onClick={() => onAction("CONFIRM")} disabled={busy}>
            Accept booking
          </Button>
        ) : null}

        {/* A genuine shortfall is chased on WhatsApp; an advance balance is not a
            shortfall, so it gets the Record button above instead. */}
        {takesPayment && booking.amountPaid > 0 && !collectsBalance ? (
          <Button
            size="sm"
            variant="whatsapp"
            className="h-10 flex-1 sm:h-9 sm:flex-none"
            onClick={() => onWhatsapp("BALANCE")}
            disabled={busy}
          >
            Ask for {formatCurrency(booking.amountRemaining)}
          </Button>
        ) : null}

        {booking.status === "CONFIRMED" ? (
          <Button
            size="sm"
            variant="whatsapp"
            className="h-10 flex-1 sm:h-9 sm:flex-none"
            onClick={() => onWhatsapp("CONFIRM")}
            disabled={busy}
          >
            Confirm via WhatsApp
          </Button>
        ) : null}

        {booking.status === "REJECTED" ? (
          <Button
            size="sm"
            variant="whatsapp"
            className="h-10 flex-1 sm:h-9 sm:flex-none"
            onClick={() => onWhatsapp("REJECT")}
            disabled={busy}
          >
            Reject via WhatsApp
          </Button>
        ) : null}

        {booking.hasScreenshot ? (
          <a href={`/api/admin/bookings/${booking.id}/screenshot`} target="_blank" rel="noopener noreferrer">
            <Button variant="secondary" size="sm" className="h-10 w-full sm:h-9 sm:w-auto">
              <ImageIcon className="h-4 w-4" aria-hidden="true" />
              Screenshot
              <ExternalLink className="h-3 w-3" aria-hidden="true" />
            </Button>
          </a>
        ) : null}

        {/* Releasing someone's slots is irreversible, so it is pushed to the end
            and styled quietly. */}
        {isPending ? (
          <Button
            size="sm"
            variant="secondary"
            className="h-10 border-red-200 text-red-700 hover:bg-red-50 hover:text-red-800 sm:ml-auto sm:h-9"
            onClick={() => onAction("REJECT")}
            disabled={busy}
          >
            Reject &amp; release
          </Button>
        ) : null}

        {busy ? <Spinner className="self-center text-ink-500" /> : null}
      </div>

      <p className="mt-2.5 text-[11px] text-ink-400">Requested {formatIstTimestamp(booking.createdAt)}</p>
    </li>
  );
}
