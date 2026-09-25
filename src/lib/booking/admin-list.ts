import "server-only";
import { ObjectId, type Filter } from "mongodb";
import { collections, getDb } from "@/lib/db";
import { isValidBusinessDate } from "@/lib/time";
import { BOOKING_TABS, type BookingDoc, type BookingStatus, type BookingTab, type PaymentStatus } from "@/lib/types";

export const BOOKINGS_PAGE_SIZE = 20;

/**
 * A payment attempt nobody has ruled on yet, on a booking that is still alive.
 *
 * The status half matters: a booking rejected while its screenshot was unchecked
 * — the slot blocked for rain, say — keeps that attempt PENDING forever, and
 * without it the dead booking sat in the queue and rang the bell. It belongs to
 * the Rejected tab only. Shared by the tab, the bell and the dashboard card so
 * the three numbers cannot disagree.
 */
export const TO_VERIFY: Filter<BookingDoc> = {
  "payments.status": "PENDING",
  status: { $in: ["PENDING", "CONFIRMED"] },
};

function tabFilter(tab: BookingTab): Filter<BookingDoc> {
  switch (tab) {
    case "pending":
      return { status: "PENDING" };
    case "verify":
      return TO_VERIFY;
    case "confirmed":
      return { status: "CONFIRMED" };
    // Grouped: from the owner's side a rejected, cancelled and expired booking are
    // one thing — a slot that went back on sale.
    case "rejected":
      return { status: { $in: ["REJECTED", "CANCELLED", "EXPIRED"] } };
    default:
      return {};
  }
}

export interface AdminBookingsQuery {
  page: number;
  locationId?: string;
  date?: string;
  tab?: BookingTab;
  status?: BookingStatus;
  payment?: PaymentStatus;
  search?: string;
  sport?: string;
}

/**
 * The admin booking list, in one place.
 *
 * Both the API the browser polls and the server render of the page itself go
 * through here. Two copies of this query would be two chances for the first
 * paint and the first refresh to disagree about what the owner is looking at.
 */
export async function listBookings(query: AdminBookingsQuery) {
  /**
   * Everything EXCEPT the tab: which ground, which day, what was searched for.
   *
   * Kept separate because the tab counts are taken against this rather than
   * against the whole filter — a "Pending 3" that changes to "Pending 0" the
   * moment you open the Pending tab would be useless.
   */
  const scope: Filter<BookingDoc> = {};
  // One ground or several, comma-separated; anything that is not an id is ignored.
  const grounds = (query.locationId ?? "").split(",").filter((id) => ObjectId.isValid(id));
  if (grounds.length) scope.locationId = { $in: grounds.map((id) => new ObjectId(id)) };
  if (query.date && isValidBusinessDate(query.date)) scope.date = query.date;
  // By name, not id: "Bowling Machine" is two facilities at two grounds, and the
  // owner filtering for it means both.
  if (query.sport) scope.facilityName = query.sport;

  if (query.search) {
    const term = query.search.trim();
    const digits = term.replace(/\D/g, "");
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    scope.$or = [
      { reference: new RegExp(`^${escaped}`, "i") },
      { customerName: new RegExp(escaped, "i") },
      ...(digits.length >= 4 ? [{ customerPhone: new RegExp(digits.slice(-10)) }] : []),
      // Reconciliation runs the other way round too: the owner has an unfamiliar
      // line in the bank statement and wants to know whose booking it paid for.
      ...(digits.length >= 6 ? [{ "payments.utr": new RegExp(digits) }] : []),
    ];
  }

  const tab: BookingTab = query.tab ?? "all";
  // `status` and `payment` are still honoured so a bookmarked or shared link from
  // before the tabs existed keeps working.
  const filter: Filter<BookingDoc> = { ...scope, ...tabFilter(tab) };
  if (query.status) filter.status = query.status;
  if (query.payment) filter.paymentVerificationStatus = query.payment;

  const db = await getDb();
  const cursor = collections
    .bookings(db)
    .find(filter, { projection: { holdTokenHash: 0 } })
    .sort({ createdAt: -1 })
    .skip((query.page - 1) * BOOKINGS_PAGE_SIZE)
    .limit(BOOKINGS_PAGE_SIZE);

  const [bookings, total, counts] = await Promise.all([
    cursor.toArray(),
    collections.bookings(db).countDocuments(filter),
    tabCounts(db, scope),
  ]);

  return {
    bookings: bookings.map(serialiseForList),
    page: query.page,
    pageSize: BOOKINGS_PAGE_SIZE,
    total,
    totalPages: Math.max(1, Math.ceil(total / BOOKINGS_PAGE_SIZE)),
    tab,
    counts,
  };
}

/**
 * How many bookings sit behind each tab, in one round trip.
 *
 * A `$facet` rather than five `countDocuments` calls: the tabs are read on every
 * keystroke of the search box, and five queries per keystroke is five times the
 * load for a number that is only ever glanced at.
 */
async function tabCounts(
  db: Awaited<ReturnType<typeof getDb>>,
  scope: Filter<BookingDoc>,
): Promise<Record<BookingTab, number>> {
  const facet = Object.fromEntries(
    BOOKING_TABS.map((t) => [t.id, [{ $match: tabFilter(t.id) }, { $count: "n" }]]),
  );
  const [result] = await collections
    .bookings(db)
    .aggregate<Record<string, Array<{ n: number }>>>([{ $match: scope }, { $facet: facet }])
    .toArray();

  return Object.fromEntries(BOOKING_TABS.map((t) => [t.id, result?.[t.id]?.[0]?.n ?? 0])) as Record<
    BookingTab,
    number
  >;
}

export type AdminBookingList = Awaited<ReturnType<typeof listBookings>>;

/**
 * Where this booking stands on evidence.
 *
 * FAILED only when no image ever landed AND an attempt says the store refused
 * one — so a booking the owner wrote in by hand, which never had a screenshot to
 * lose, is never flagged as a failure.
 */
function screenshotOutcome(b: BookingDoc): "UPLOADED" | "FAILED" | "NONE" {
  if (b.paymentScreenshotKey) return "UPLOADED";
  return (b.payments ?? []).some((p) => p.uploadStatus === "FAILED") ? "FAILED" : "NONE";
}

function serialiseForList(b: BookingDoc) {
  return {
    id: b._id.toHexString(),
    reference: b.reference,
    locationId: b.locationId.toHexString(),
    locationName: b.locationName,
    // Snapshots taken at booking time, so a later rename does not rewrite
    // what the customer actually booked.
    facilityName: b.facilityName ?? "",
    resourceName: b.resourceName ?? "",
    overs: b.overs ?? null,
    ballTypeName: b.ballTypeName ?? null,
    phoneVerified: Boolean(b.phoneVerified),
    // A short bowling session is confirmed without paying, so "nothing
    // received" on it is expected rather than a problem to chase.
    payAtVenue: Boolean(b.payAtVenue),
    // Null unless the owner wrote this one in from a phone call, which is why
    // it has no screenshot and often no money yet.
    createdBy: b.createdBy ?? null,
    /**
     * How this booking paid online, or null for one that never had to.
     *
     * The admin screen needs it to know which absences are normal: a RAZORPAY
     * booking has no screenshot and no UTR to review because the gateway settled
     * it, and showing "no screenshot" beside it would send the owner looking for
     * one that was never meant to exist.
     */
    paymentMethod: b.paymentMethod ?? null,
    date: b.date,
    startMin: b.startMin,
    endMin: b.endMin,
    amount: b.amount,
    // What this customer agreed to pay online. Less than `amount` means they took
    // the advance, which is why a part payment on it is not a shortfall to chase.
    amountDueNow: b.amountDueNow ?? b.amount,
    customerName: b.customerName,
    customerPhone: b.customerPhone,
    status: b.status,
    paymentVerificationStatus: b.paymentVerificationStatus,
    amountPaid: b.amountPaid ?? 0,
    amountRemaining: Math.max(0, b.amount - (b.amountPaid ?? 0)),
    payments: (b.payments ?? []).map((p) => ({
      id: p.id,
      uploadedAt: p.uploadedAt.toISOString(),
      amount: p.amount,
      status: p.status,
      note: p.note,
      utr: p.utr ?? null,
      hasScreenshot: Boolean(p.screenshotKey),
      screenshotExpired: Boolean(p.screenshotExpiredAt),
      /*
       * What became of the image. Defaulted for attempts recorded before this
       * was tracked: those have a key or they do not, and neither was ever a
       * storage failure — the fallback did not exist when they were written.
       */
      uploadStatus: p.uploadStatus ?? (p.screenshotKey ? "UPLOADED" : "NONE"),
      uploadFailureReason: p.uploadFailureReason ?? null,
      // Absent on every attempt taken before the gateway existed, all of which
      // were somebody reading a screenshot.
      provider: p.provider ?? "MANUAL",
      razorpayPaymentId: p.razorpayPaymentId ?? null,
      razorpayMethod: p.razorpayMethod ?? null,
    })),
    /**
     * The customer paid, sent a valid screenshot, and our storage refused it.
     *
     * Surfaced on the booking itself rather than left for the owner to work out
     * from an empty screenshot button: this is the one case where a missing image
     * is our fault and the payment still has to be checked by hand.
     */
    screenshotUploadStatus: screenshotOutcome(b),
    hasScreenshot: Boolean(b.paymentScreenshotKey),
    rejectionReason: b.rejectionReason,
    createdAt: b.createdAt.toISOString(),
  };
}
