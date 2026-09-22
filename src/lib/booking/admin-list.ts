import "server-only";
import { ObjectId, type Filter } from "mongodb";
import { collections, getDb } from "@/lib/db";
import { isValidBusinessDate } from "@/lib/time";
import type { BookingDoc, BookingStatus, PaymentStatus } from "@/lib/types";

export const BOOKINGS_PAGE_SIZE = 20;

export interface AdminBookingsQuery {
  page: number;
  locationId?: string;
  date?: string;
  status?: BookingStatus;
  payment?: PaymentStatus;
  search?: string;
}

/**
 * The admin booking list, in one place.
 *
 * Both the API the browser polls and the server render of the page itself go
 * through here. Two copies of this query would be two chances for the first
 * paint and the first refresh to disagree about what the owner is looking at.
 */
export async function listBookings(query: AdminBookingsQuery) {
  const filter: Filter<BookingDoc> = {};
  if (query.locationId && ObjectId.isValid(query.locationId)) filter.locationId = new ObjectId(query.locationId);
  if (query.date && isValidBusinessDate(query.date)) filter.date = query.date;
  if (query.status) filter.status = query.status;
  if (query.payment) filter.paymentVerificationStatus = query.payment;

  if (query.search) {
    const term = query.search.trim();
    const digits = term.replace(/\D/g, "");
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    filter.$or = [
      { reference: new RegExp(`^${escaped}`, "i") },
      { customerName: new RegExp(escaped, "i") },
      ...(digits.length >= 4 ? [{ customerPhone: new RegExp(digits.slice(-10)) }] : []),
      // Reconciliation runs the other way round too: the owner has an unfamiliar
      // line in the bank statement and wants to know whose booking it paid for.
      ...(digits.length >= 6 ? [{ "payments.utr": new RegExp(digits) }] : []),
    ];
  }

  const db = await getDb();
  const cursor = collections
    .bookings(db)
    .find(filter, { projection: { holdTokenHash: 0 } })
    .sort({ createdAt: -1 })
    .skip((query.page - 1) * BOOKINGS_PAGE_SIZE)
    .limit(BOOKINGS_PAGE_SIZE);

  const [bookings, total] = await Promise.all([cursor.toArray(), collections.bookings(db).countDocuments(filter)]);

  return {
    bookings: bookings.map(serialiseForList),
    page: query.page,
    pageSize: BOOKINGS_PAGE_SIZE,
    total,
    totalPages: Math.max(1, Math.ceil(total / BOOKINGS_PAGE_SIZE)),
  };
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
