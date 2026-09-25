"use client";

import * as React from "react";
import {
  BadgeCheck,
  Banknote,
  CalendarDays,
  Check,
  ChevronDown,
  CircleCheck,
  CircleX,
  Clock3,
  Contrast,
  Copy,
  HandCoins,
  CreditCard,
  ExternalLink,
  Hourglass,
  Image as ImageIcon,
  MapPin,
  Phone,
  Receipt,
  Search,
  Trophy,
  TriangleAlert,
  Wallet,
  X,
  type LucideIcon,
} from "lucide-react";
import { api, errorMessage } from "@/lib/client";
import { formatBusinessDate, formatIstTimestamp, formatRange, minutesToDuration } from "@/lib/time";
import { Alert, Button, EmptyState, Spinner, StatusBadge, cn, formatCurrency } from "@/components/ui/primitives";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { PaymentReviewDialog, type PaymentAttemptView } from "@/components/admin/payment-review-dialog";
import { sportEmoji } from "@/lib/sport";
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
  sports,
  today,
  initialFilters,
  initialList,
}: {
  locations: Array<{ id: string; name: string }>;
  /** Every service name, once each however many grounds sell it — the Sport filter. */
  sports: string[];
  /** Today in Asia/Kolkata, from the server — never the admin's device clock. */
  today: string;
  initialFilters: {
    locationId?: string;
    date?: string;
    tab?: string;
    status?: string;
    payment?: string;
    search?: string;
    sport?: string;
  };
  /** Page one for these filters, already queried on the server. */
  initialList: ListResponse;
}) {
  const [locationId, setLocationId] = React.useState(initialFilters.locationId ?? "");
  const [date, setDate] = React.useState(initialFilters.date ?? "");
  const [tab, setTab] = React.useState<BookingTab>((initialFilters.tab as BookingTab) ?? "all");
  const [search, setSearch] = React.useState(initialFilters.search ?? "");
  const [sport, setSport] = React.useState(initialFilters.sport ?? "");
  const [page, setPage] = React.useState(1);

  const [data, setData] = React.useState<ListResponse | null>(initialList);
  const [loading, setLoading] = React.useState(false);
  const [listError, setListError] = React.useState<string | null>(null);

  const [pending, setPending] = React.useState<PendingAction | null>(null);
  const [reviewing, setReviewing] = React.useState<AdminBooking | null>(null);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [actionError, setActionError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);

  const queryFor = React.useCallback(
    (forTab: BookingTab, forPage: number) => {
      const params = new URLSearchParams({ page: String(forPage) });
      if (locationId) params.set("locationId", locationId);
      if (date) params.set("date", date);
      if (forTab !== "all") params.set("tab", forTab);
      if (search.trim()) params.set("search", search.trim());
      if (sport) params.set("sport", sport);
      return `/api/admin/bookings?${params.toString()}`;
    },
    [locationId, date, search, sport],
  );

  /**
   * Every list already fetched, by its query.
   *
   * A tab the owner has seen once shows its last answer the instant it is tapped
   * and is refreshed underneath, instead of blanking to a spinner for a round
   * trip already waited through once. Emptied after anything the owner changes,
   * so a cached copy can never show a booking in a state it has since left.
   */
  const seen = React.useRef(new Map<string, ListResponse>([[queryFor(tab, 1), initialList]]));
  /** The query on screen now: an answer that comes back for an older tap is dropped. */
  const current = React.useRef("");

  const load = React.useCallback(async () => {
    const url = queryFor(tab, page);
    current.current = url;
    const cached = seen.current.get(url);
    if (cached) setData(cached);
    else setLoading(true);
    setListError(null);
    try {
      const fresh = await api<ListResponse>(url);
      seen.current.set(url, fresh);
      if (current.current === url) setData(fresh);
    } catch (err) {
      if (current.current === url) setListError(errorMessage(err));
    } finally {
      if (current.current === url) setLoading(false);
    }
  }, [queryFor, tab, page]);

  /** Drop every remembered list, then fetch the one on screen. */
  const reload = React.useCallback(async () => {
    seen.current.clear();
    await load();
  }, [load]);

  /*
   * The other tabs, fetched quietly once the list is up, so even the first tap
   * on each is instant. Not while a search is being typed: that would be five
   * requests a keystroke for lists nobody has asked to see.
   */
  React.useEffect(() => {
    if (search.trim()) return;
    const id = window.setTimeout(() => {
      for (const t of BOOKING_TABS) {
        const url = queryFor(t.id, 1);
        if (t.id === tab || seen.current.has(url)) continue;
        api<ListResponse>(url)
          .then((r) => seen.current.set(url, r))
          .catch(() => {
            // A tab that could not be fetched ahead is simply fetched when tapped.
          });
      }
    }, 400);
    return () => window.clearTimeout(id);
    // Only when the filters change, not on every tab tap — the tab is read once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryFor]);

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
  }, [locationId, date, tab, search, sport]);

  /** Tells the header bell that the queue it counts may have moved. */
  const announceChange = () => window.dispatchEvent(new Event("admin:bookings-changed"));

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
        await reload();
        announceChange();
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
      await reload();
      announceChange();
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
      await reload();
      announceChange();
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
  const counts = data?.counts;
  const anyFilter = Boolean(locationId || date || sport || search);
  const groundName = locations.find((l) => l.id === locationId)?.name ?? null;

  return (
    <div className="space-y-4">
      {/* Taking a booking over the phone has its own tab now; this one is for
          working through the ones that already exist. */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-ink-900">Bookings</h1>
        <p className="text-sm text-ink-600">Verify payments, accept or reject requests.</p>
      </div>

      <section className="space-y-3" aria-label="Find bookings">
        {/*
          A form only so the phone keyboard shows a Search key. The list already
          follows the typing, so pressing it just puts the keyboard away and the
          results — which it was covering — into view.
        */}
        <form
          role="search"
          className="relative"
          onSubmit={(e) => {
            e.preventDefault();
            (document.activeElement as HTMLElement | null)?.blur();
          }}
        >
          <Search
            className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-400"
            aria-hidden="true"
          />
          <input
            id="filter-search"
            className="field-input h-12 rounded-xl pl-10 pr-10 text-base shadow-sm"
            placeholder="Search name, phone, reference or UTR"
            aria-label="Search bookings"
            enterKeyHint="search"
            autoComplete="off"
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
        </form>

        {/* Scrolls sideways rather than wrapping: five wrapped pills push the first
            booking off a phone screen. The fade on the right edge is what says
            there is more to scroll to — without it the strip just looks clipped. */}
        <div className="relative -mx-4 sm:mx-0">
          <div
            role="tablist"
            aria-label="Booking status"
            className="flex gap-1.5 overflow-x-auto px-4 pb-1 [scrollbar-width:none] sm:px-0 [&::-webkit-scrollbar]:hidden"
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
                    "flex h-11 shrink-0 items-center gap-2 rounded-xl px-4 text-sm font-semibold transition-colors",
                    on ? "bg-pitch-600 text-white shadow-sm" : "text-ink-700 hover:bg-white",
                  )}
                >
                  {t.id === "all" ? "All bookings" : t.label}
                  {/* The count is the point of the tab: "To verify 4" is a to-do list. */}
                  {typeof n === "number" ? (
                    <span
                      className={cn(
                        "grid h-6 min-w-6 place-items-center rounded-full px-1.5 text-xs font-bold tabular-nums",
                        on ? "bg-white text-pitch-700" : TAB_COUNT_TONE[t.id],
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

        {/* Three pills, each a native control underneath: the phone's own date
            and list pickers, which are faster to use than anything drawn here. */}
        <div className="grid grid-cols-3 gap-2 sm:flex sm:flex-wrap">
          <FilterPill icon={CalendarDays} label="Date" value={date ? (date === today ? "Today" : formatBusinessDate(date)) : null}>
            <input
              id="filter-date"
              type="date"
              aria-label="Date"
              className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
              value={date}
              onClick={(e) => {
                // Desktop browsers only open the calendar from their own tiny icon,
                // which is invisible here. Mobile ones open it on any tap anyway.
                try {
                  e.currentTarget.showPicker();
                } catch {
                  /* not supported: the tap still focuses the field */
                }
              }}
              onChange={(e) => setDate(e.target.value)}
            />
          </FilterPill>
          <FilterPill icon={MapPin} label="Ground" value={groundName}>
            <select
              id="filter-location"
              aria-label="Ground"
              className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
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
          </FilterPill>
          <FilterPill icon={Trophy} label="Sport" value={sport || null}>
            <select
              id="filter-sport"
              aria-label="Sport"
              className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
              value={sport}
              onChange={(e) => setSport(e.target.value)}
            >
              <option value="">All sports</option>
              {sports.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </FilterPill>
          {/* Always reachable, so a filter left on last week can be cleared
              without first remembering where it was set. */}
          {anyFilter ? (
            <button
              type="button"
              className="col-span-3 flex h-9 items-center justify-center gap-1.5 rounded-xl text-sm font-medium text-ink-600 hover:bg-white hover:text-ink-900 sm:col-span-1 sm:h-11 sm:px-3"
              onClick={() => {
                setLocationId("");
                setDate("");
                setSport("");
                setSearch("");
              }}
            >
              <X className="h-4 w-4" aria-hidden="true" />
              Clear filters
            </button>
          ) : null}
        </div>
      </section>

      {notice ? (
        <Alert tone="success" className="flex items-center justify-between gap-3 rounded-xl">
          <span className="flex min-w-0 items-start gap-2 break-words">
            <CircleCheck className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            {notice}
          </span>
          <button type="button" className="h-11 shrink-0 px-2 text-xs underline" onClick={() => setNotice(null)}>
            Dismiss
          </button>
        </Alert>
      ) : null}
      {actionError ? <Alert tone="error" className="rounded-xl">{actionError}</Alert> : null}
      {listError ? <Alert tone="error" className="rounded-xl">{listError}</Alert> : null}

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
                className="h-11 flex-1 rounded-xl sm:h-9 sm:flex-none"
                disabled={(data?.page ?? 1) <= 1}
                onClick={() => setPage((p) => p - 1)}
              >
                Previous
              </Button>
              <Button
                variant="secondary"
                size="sm"
                className="h-11 flex-1 rounded-xl sm:h-9 sm:flex-none"
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
        confirmLabel={pending ? `Mark ${formatCurrency(pending.booking.amountRemaining)} collected` : "Mark collected"}
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

/** The count bubble on each tab, coloured like the state it counts. */
const TAB_COUNT_TONE: Record<BookingTab, string> = {
  all: "bg-ink-200/70 text-ink-700",
  pending: "bg-amber-100 text-amber-800",
  verify: "bg-blue-100 text-blue-700",
  confirmed: "bg-green-100 text-green-700",
  rejected: "bg-red-100 text-red-700",
};

/** A dropdown-looking pill with the real native control stretched invisibly over it. */
function FilterPill({
  icon: Icon,
  label,
  value,
  children,
}: {
  icon: LucideIcon;
  label: string;
  /** What is chosen, or null to show the label. */
  value: string | null;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "relative flex h-11 min-w-0 items-center gap-1.5 rounded-xl border px-2.5 text-[13px] shadow-sm transition-colors",
        "focus-within:ring-2 focus-within:ring-pitch-500/30 sm:min-w-44 sm:gap-2 sm:px-3 sm:text-sm",
        value ? "border-pitch-300 bg-pitch-50 text-pitch-800" : "border-ink-200 bg-white text-ink-700 hover:border-ink-300",
      )}
    >
      <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate font-medium">{value ?? label}</span>
      <ChevronDown className="h-4 w-4 shrink-0 opacity-60" aria-hidden="true" />
      {children}
    </div>
  );
}

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

/**
 * How the card looks as a whole. The edge colour, the avatar, the pill and the
 * payment panel all follow this one answer, so they can never disagree.
 */
type Look = "confirmed" | "verify" | "partial" | "waiting" | "dead";

function lookOf(b: AdminBooking, tone: ReturnType<typeof paymentSummary>["tone"]): Look {
  if (b.status === "REJECTED" || b.status === "CANCELLED" || b.status === "EXPIRED") return "dead";
  if (b.status === "CONFIRMED") return "confirmed";
  // A payment nobody has ruled on yet: exactly what the To verify tab counts.
  if (b.payments.some((p) => p.status === "PENDING")) return "verify";
  if (tone === "short") return "partial";
  return "waiting";
}

const LOOK_STYLE: Record<Look, { accent: string; avatar: string }> = {
  confirmed: { accent: "bg-green-500", avatar: "bg-green-50 text-green-700" },
  verify: { accent: "bg-blue-500", avatar: "bg-blue-50 text-blue-700" },
  partial: { accent: "bg-orange-500", avatar: "bg-orange-50 text-orange-700" },
  waiting: { accent: "bg-amber-400", avatar: "bg-amber-50 text-amber-800" },
  dead: { accent: "bg-ink-300", avatar: "bg-ink-100 text-ink-500" },
};

type PanelTone = "green" | "amber" | "blue" | "orange" | "grey" | "red";

const PANEL_STYLE: Record<PanelTone, { box: string; tile: string; title: string; amount: string }> = {
  green: { box: "border-green-200 bg-green-50", tile: "bg-green-100 text-green-700", title: "text-green-900", amount: "text-green-800" },
  amber: { box: "border-amber-300 bg-amber-50", tile: "bg-amber-100 text-amber-700", title: "text-amber-900", amount: "text-amber-900" },
  blue: { box: "border-blue-200 bg-blue-50", tile: "bg-blue-100 text-blue-700", title: "text-blue-900", amount: "text-blue-800" },
  orange: { box: "border-orange-200 bg-orange-50", tile: "bg-orange-100 text-orange-700", title: "text-orange-900", amount: "text-orange-800" },
  grey: { box: "border-ink-200 bg-ink-50", tile: "bg-white text-ink-500", title: "text-ink-800", amount: "text-ink-800" },
  red: { box: "border-red-200 bg-red-50", tile: "bg-red-100 text-red-700", title: "text-red-900", amount: "text-red-800" },
};

interface Panel {
  tone: PanelTone;
  icon: LucideIcon;
  title: string;
  /** A tick after the title, for money that has actually been checked. */
  verified?: boolean;
  big: string;
  caption: string;
  /** A second figure under the first, e.g. the balance still due. */
  second?: string;
  /** Replaces the UTR / payment-method line under the title. */
  sub?: string;
  /** Money still to take from the customer at the ground, said on its own line. */
  collect?: number;
}

/** The money strip, in the owner's words — built on the same summary as before. */
function moneyPanel(b: AdminBooking, look: Look, money: ReturnType<typeof paymentSummary>): Panel {
  const atGround = b.amountRemaining;
  if (look === "verify") {
    const attempt = [...b.payments].reverse().find((p) => p.status === "PENDING");
    return {
      tone: "blue",
      icon: Receipt,
      title: "Payment received",
      big: formatCurrency(attempt?.amount ?? Math.max(0, b.amountDueNow - b.amountPaid)),
      caption: "under verification",
    };
  }
  switch (money.tone) {
    case "paid":
      return {
        tone: "green",
        icon: CreditCard,
        title: "Fully paid",
        verified: true,
        big: formatCurrency(b.amountPaid),
        caption: "paid",
        sub: "Nothing to collect",
      };
    // Yellow, not green: money is still owed, and it is the owner who has to
    // take it off the customer at the gate.
    case "advance":
      return b.amountPaid > 0
        ? {
            tone: "amber",
            icon: Wallet,
            // "Half" only when it is exactly half; an advance set at some other
            // share would be misdescribed by it.
            title: b.amountPaid * 2 === b.amount ? "Half paid" : "Part paid",
            big: formatCurrency(b.amountPaid),
            caption: "received",
            collect: atGround,
          }
        : {
            tone: "amber",
            icon: Banknote,
            title: b.createdBy ? "Booked by phone" : "Pay at the ground",
            big: formatCurrency(b.amount),
            caption: "total",
            sub: "Nothing paid yet",
            collect: atGround,
          };
    case "short":
      return {
        tone: "orange",
        icon: Wallet,
        title: "Partial payment received",
        big: formatCurrency(b.amountPaid),
        caption: "received",
        second: `${formatCurrency(b.amountDueNow - b.amountPaid)} due`,
      };
    case "dead":
      return b.amountPaid > 0
        ? { tone: "red", icon: TriangleAlert, title: "May need refunding", big: formatCurrency(b.amountPaid), caption: "received" }
        : { tone: "grey", icon: CircleX, title: "Slots released", big: formatCurrency(b.amount), caption: "nothing received" };
    default:
      return {
        tone: "grey",
        icon: b.paymentMethod === "RAZORPAY" ? Hourglass : Clock3,
        title: money.line,
        big: formatCurrency(b.amountDueNow),
        caption: b.amountDueNow < b.amount ? "advance due" : "due",
      };
  }
}

function StatePill({ booking, look }: { booking: AdminBooking; look: Look }) {
  const attempt = [...booking.payments].reverse().find((p) => p.status === "PENDING");
  const pill: { icon: LucideIcon; label: string; sub?: string; tone: string } = {
    confirmed: { icon: CircleCheck, label: "Confirmed", tone: "bg-green-50 text-green-800 ring-green-600/20" },
    verify: {
      icon: Clock3,
      label: "Payment received",
      sub: attempt?.hasScreenshot || booking.hasScreenshot ? "Verify screenshot" : "Verify payment",
      tone: "bg-blue-50 text-blue-800 ring-blue-600/20",
    },
    partial: { icon: Contrast, label: "Partial", tone: "bg-orange-50 text-orange-800 ring-orange-600/20" },
    waiting: {
      icon: Hourglass,
      label: booking.paymentMethod === "RAZORPAY" && booking.amountPaid === 0 ? "Awaiting payment" : "Pending",
      tone: "bg-amber-50 text-amber-900 ring-amber-600/25",
    },
    dead: {
      icon: CircleX,
      label: booking.status.charAt(0) + booking.status.slice(1).toLowerCase(),
      tone: "bg-red-50 text-red-700 ring-red-600/15",
    },
  }[look];

  return (
    <span className={cn("inline-flex shrink-0 flex-col items-end rounded-xl px-2 py-0.5 text-right ring-1 ring-inset", pill.tone)}>
      <span className="flex items-center gap-1 whitespace-nowrap text-xs font-semibold leading-5">
        <pill.icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        {pill.label}
      </span>
      {pill.sub ? <span className="whitespace-nowrap text-[10px] font-medium leading-4 opacity-80">{pill.sub}</span> : null}
    </span>
  );
}

/** The booking reference, one tap to copy — it is what gets pasted into WhatsApp and the bank app. */
function CopyReference({ reference }: { reference: string }) {
  const [copied, setCopied] = React.useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(reference);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        } catch {
          // Clipboard blocked (an old browser, an insecure origin): the text is
          // still there to select by hand.
        }
      }}
      aria-label={copied ? "Reference copied" : `Copy reference ${reference}`}
      className="-my-1 inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 font-mono text-[13px] tracking-wide text-ink-500 hover:bg-ink-100 hover:text-ink-800"
    >
      {copied ? (
        <Check className="h-3.5 w-3.5 text-green-600" aria-hidden="true" />
      ) : (
        <Copy className="h-3.5 w-3.5" aria-hidden="true" />
      )}
      {reference}
    </button>
  );
}

/** WhatsApp's own mark: a generic chat bubble does not read as "WhatsApp" at a glance. */
function WhatsAppIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z" />
    </svg>
  );
}

/**
 * Two per row on a phone rather than a stack of full-width bars, which pushed the
 * next booking off the screen. Each starts at its own label's width and never
 * shrinks below it: an equal split squeezed "Confirm via WhatsApp" until its
 * icon and ends were cut off. One that does not fit takes the next row instead.
 */
const ACTION = "h-11 flex-[1_0_auto] rounded-xl sm:h-10 sm:flex-none sm:px-5";
const SOFT_GREEN =
  "theme-light:border-green-200 theme-light:bg-green-100 theme-light:text-green-800 theme-light:hover:bg-green-200";
const SOFT_RED = "theme-light:border-red-200 theme-light:bg-red-50 theme-light:text-red-700 theme-light:hover:bg-red-100";

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
  const look = lookOf(booking, money.tone);
  const panel = moneyPanel(booking, look, money);
  const panelStyle = PANEL_STYLE[panel.tone];

  /** How the money came in, said where a UTR would otherwise go. */
  const gatewayMethod = [...booking.payments].reverse().find((p) => p.razorpayMethod)?.razorpayMethod;
  const methodLabel = booking.createdBy
    ? "Booked by phone"
    : booking.payAtVenue
      ? "Pay at the ground"
      : gateway
        ? `Razorpay${gatewayMethod ? ` · ${gatewayMethod.toUpperCase()}` : ""}`
        : "UPI screenshot";

  /** What the customer actually turns up to use. */
  const service = [booking.facilityName, booking.resourceName !== booking.facilityName ? booking.resourceName : null]
    .filter(Boolean)
    .join(" · ");

  /** The balance an advance customer hands over — one press, not a review dialog. */
  const collectsBalance = booking.amountRemaining > 0 && onAdvance && metWhatWasDue;

  /** The screenshot waiting to be checked, shown as a thumbnail beside the money. */
  const attempt = [...booking.payments].reverse().find((p) => p.status === "PENDING");
  const shotUrl = attempt?.hasScreenshot
    ? `/api/admin/bookings/${booking.id}/screenshot?attempt=${attempt.id}`
    : `/api/admin/bookings/${booking.id}/screenshot`;
  const thumbnail = look === "verify" && (attempt?.hasScreenshot || booking.hasScreenshot);

  return (
    <li
      className={cn(
        "relative overflow-hidden rounded-2xl border border-ink-200 bg-white p-4 pl-5 shadow-sm sm:p-5 sm:pl-6",
        busy && "opacity-70",
      )}
    >
      <span aria-hidden="true" className={cn("absolute inset-y-0 left-0 w-1.5", LOOK_STYLE[look].accent)} />

      {/* 1. Who — name, how to reach them, and where the booking stands. */}
      <div className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className={cn(
            "grid h-12 w-12 shrink-0 place-items-center rounded-full text-lg font-bold uppercase",
            LOOK_STYLE[look].avatar,
          )}
        >
          {booking.customerName.trim().charAt(0) || "?"}
        </span>

        <div className="min-w-0 flex-1">
          {/* The pill shares the name's row only, so the contact line underneath
              gets the full width instead of wrapping the number in two. */}
          <div className="flex items-start justify-between gap-2">
            <p className="min-w-0 truncate pt-1 text-lg font-bold leading-tight text-ink-900">{booking.customerName}</p>
            <StatePill booking={booking} look={look} />
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-ink-600">
            <a
              href={`tel:+91${booking.customerPhone}`}
              className="inline-flex items-center gap-1.5 whitespace-nowrap font-medium hover:text-pitch-700"
            >
              <Phone className="h-3.5 w-3.5 text-ink-400" aria-hidden="true" />
              +91 {booking.customerPhone}
            </a>
            <CopyReference reference={booking.reference} />
          </div>
        </div>
      </div>

      {/* 2. What and when. The two things asked about on the phone. */}
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div className="flex min-w-0 items-center gap-3">
          <span
            aria-hidden="true"
            className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-orange-50 text-xl"
          >
            {sportEmoji(booking.facilityName)}
          </span>
          <div className="min-w-0">
            <p className="truncate font-semibold text-pitch-800">{service || booking.locationName}</p>
            {service ? <p className="truncate text-sm text-ink-500">{booking.locationName}</p> : null}
          </div>
        </div>
        <div className="flex min-w-0 items-center gap-3">
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-ink-100 text-ink-600">
            <CalendarDays className="h-5 w-5" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <p className="font-semibold text-ink-900">{formatBusinessDate(booking.date)}</p>
            <p className="text-sm text-ink-700">
              {formatRange(booking.startMin, booking.endMin)}{" "}
              <span className="text-ink-400">
                (
                {booking.overs !== null
                  ? `${booking.overs} overs${booking.ballTypeName ? `, ${booking.ballTypeName}` : ""}`
                  : minutesToDuration(booking.endMin - booking.startMin)}
                )
              </span>
            </p>
          </div>
        </div>
      </div>

      {/* 3. The money, as one panel whose colour says whether anything is owed. */}
      <div className="mt-4 flex gap-2">
        <div className={cn("min-w-0 flex-1 rounded-xl border px-3 py-3", panelStyle.box)}>
        <div className="flex min-w-0 items-center gap-3">
          <span
            aria-hidden="true"
            className={cn(
              "h-11 w-11 shrink-0 place-items-center rounded-xl",
              thumbnail ? "hidden sm:grid" : "grid",
              panelStyle.tile,
            )}
          >
            <panel.icon className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <p className={cn("flex items-center gap-1.5 font-semibold leading-snug", panelStyle.title)}>
              <span className="min-w-0 break-words">{panel.title}</span>
              {panel.verified ? <BadgeCheck className="h-4 w-4 shrink-0 text-green-600" aria-label="Verified" /> : null}
            </p>
            {/* The UTR, spelled out: it is the first thing the owner looks for when
                matching a booking to a line in the bank statement. */}
            <p className="mt-0.5 break-words text-xs text-ink-600">
              {panel.sub ? (
                panel.sub
              ) : latestUtr ? (
                <>
                  UTR: <span className="select-all font-mono font-semibold tracking-wide text-ink-800">{latestUtr}</span>
                  {gateway ? " · Razorpay" : ""}
                  {!booking.hasScreenshot && !gateway && !attempt?.hasScreenshot ? " · no screenshot, check the statement" : ""}
                </>
              ) : (
                methodLabel
              )}
            </p>
          </div>
          <div className={cn("shrink-0 text-right", panelStyle.amount)}>
            <p className="text-lg font-bold leading-tight tabular-nums sm:text-xl">
              {panel.big}
              {panel.second ? <span className="text-sm font-medium"> {panel.caption}</span> : null}
            </p>
            <p className={cn("text-xs sm:text-sm", panel.second ? "font-bold" : "font-medium opacity-80")}>
              {panel.second ?? panel.caption}
            </p>
          </div>
        </div>
        {panel.collect ? (
          <p className="mt-2.5 flex items-center gap-2 border-t border-amber-200 pt-2.5 text-sm font-semibold text-amber-900">
            <HandCoins className="h-4 w-4 shrink-0 text-amber-600" aria-hidden="true" />
            {formatCurrency(panel.collect)} to be collected from customer
          </p>
        ) : null}
        </div>

        {thumbnail ? (
          <a
            href={shotUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex w-20 shrink-0 flex-col items-center justify-center gap-1 rounded-xl border border-blue-200 bg-blue-50 p-2 text-xs font-semibold text-blue-700 transition-colors hover:bg-blue-100 sm:w-36 sm:flex-row sm:gap-2 sm:text-sm"
          >
            {/* eslint-disable-next-line @next/next/no-img-element -- a private, signed, per-admin URL; nothing to optimise or cache */}
            <img
              src={shotUrl}
              alt="Payment screenshot"
              loading="lazy"
              className="h-12 w-9 rounded-md bg-white object-cover object-top ring-1 ring-blue-200 sm:h-14 sm:w-10"
              onError={(e) => {
                e.currentTarget.style.display = "none";
              }}
            />
            <span className="flex items-center gap-1">
              View
              <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
            </span>
          </a>
        ) : null}
      </div>

      {money.tone === "short" ? (
        <p className="mt-2 flex items-start gap-2 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden="true" />
          <span>
            Short by <strong>{formatCurrency(booking.amountDueNow - booking.amountPaid)}</strong> — the slots are still
            reserved for this customer.
          </span>
        </p>
      ) : null}

      {/*
        The customer paid and sent an image; our storage would not take it. Said
        loudly, because the usual "no screenshot" signal means the customer did
        not send one, and this is the opposite situation.
      */}
      {booking.screenshotUploadStatus === "FAILED" ? (
        <p className="mt-2 flex items-start gap-2 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden="true" />
          <span>
            <span className="font-semibold">Screenshot unavailable</span> — the customer sent a valid one and our storage
            refused it. Verify against the UTR or the bank statement.
          </span>
        </p>
      ) : null}

      {booking.rejectionReason ? (
        <p className="mt-2 text-xs text-ink-600">
          <span className="text-ink-500">Reason:</span> {booking.rejectionReason}
        </p>
      ) : null}

      {/* 4. What to do about it. Same buttons, same rules as always — only the look changed. */}
      <div className="mt-4 flex flex-wrap gap-2">
        {takesPayment && !collectsBalance ? (
          <Button size="sm" className={ACTION} onClick={onReview} disabled={busy}>
            <BadgeCheck className="h-4 w-4" aria-hidden="true" />
            {/* A confirmed phone booking is not "under review" — the owner is
                writing down cash they have already taken. */}
            {isPending ? "Review payment" : `Collect ${formatCurrency(booking.amountRemaining)}`}
          </Button>
        ) : null}

        {collectsBalance ? (
          <Button size="sm" className={ACTION} onClick={() => onAction("SETTLE_BALANCE")} disabled={busy}>
            <Banknote className="h-4 w-4" aria-hidden="true" />
            Collect {formatCurrency(booking.amountRemaining)}
          </Button>
        ) : null}

        {isPending && paidInFull ? (
          <Button size="sm" className={ACTION} onClick={() => onAction("CONFIRM")} disabled={busy}>
            <Check className="h-4 w-4" aria-hidden="true" />
            Accept booking
          </Button>
        ) : null}

        {/* A genuine shortfall is chased on WhatsApp; an advance balance is not a
            shortfall, so it gets the Record button above instead. */}
        {takesPayment && booking.amountPaid > 0 && !collectsBalance ? (
          <Button size="sm" className={ACTION} onClick={() => onWhatsapp("BALANCE")} disabled={busy}>
            <WhatsAppIcon className="h-4 w-4" />
            Ask for {formatCurrency(booking.amountRemaining)}
          </Button>
        ) : null}

        {booking.status === "CONFIRMED" ? (
          <Button
            size="sm"
            variant="secondary"
            className={cn(ACTION, SOFT_GREEN)}
            onClick={() => onWhatsapp("CONFIRM")}
            disabled={busy}
          >
            <WhatsAppIcon className="h-4 w-4" />
            Confirm via WhatsApp
          </Button>
        ) : null}

        {booking.status === "REJECTED" ? (
          <Button size="sm" variant="secondary" className={ACTION} onClick={() => onWhatsapp("REJECT")} disabled={busy}>
            <WhatsAppIcon className="h-4 w-4 text-[#25D366]" />
            Reject via WhatsApp
          </Button>
        ) : null}

        {/* On a payment waiting to be checked the thumbnail above already opens it. */}
        {booking.hasScreenshot && !thumbnail ? (
          <a
            href={`/api/admin/bookings/${booking.id}/screenshot`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex flex-[1_0_auto] sm:flex-none"
          >
            <Button variant="secondary" size="sm" className="h-11 w-full rounded-xl sm:h-10 sm:px-5">
              <ImageIcon className="h-4 w-4" aria-hidden="true" />
              View screenshot
            </Button>
          </a>
        ) : null}

        {/* Releasing someone's slots is irreversible, so it is pushed to the end. */}
        {isPending ? (
          <Button
            size="sm"
            variant="secondary"
            className={cn(ACTION, SOFT_RED, "sm:ml-auto")}
            onClick={() => onAction("REJECT")}
            disabled={busy}
          >
            <X className="h-4 w-4" aria-hidden="true" />
            Reject &amp; release
          </Button>
        ) : null}

        {busy ? <Spinner className="self-center text-ink-500" /> : null}
      </div>

      <p className="mt-3 flex items-center gap-1.5 text-xs text-ink-400">
        <Clock3 className="h-3.5 w-3.5" aria-hidden="true" />
        Requested {formatIstTimestamp(booking.createdAt)}
      </p>
    </li>
  );
}
