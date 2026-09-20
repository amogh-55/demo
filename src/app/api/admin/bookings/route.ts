import { ObjectId, type Filter } from "mongodb";
import { fail, ok, readJson } from "@/lib/api";
import { recordAudit, requireAdmin } from "@/lib/auth";
import { createManualBooking } from "@/lib/booking/service";
import { collections, getDb } from "@/lib/db";
import { isValidBusinessDate } from "@/lib/time";
import type { BookingDoc } from "@/lib/types";
import { adminBookingCreateSchema, adminBookingsQuerySchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 20;

/** Paginated, filtered booking list. Every filter runs in the database, not the browser. */
export async function GET(request: Request) {
  try {
    await requireAdmin();

    const url = new URL(request.url);
    const query = adminBookingsQuerySchema.parse(Object.fromEntries(url.searchParams));

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
      .skip((query.page - 1) * PAGE_SIZE)
      .limit(PAGE_SIZE);

    const [bookings, total] = await Promise.all([cursor.toArray(), collections.bookings(db).countDocuments(filter)]);

    return ok({
      bookings: bookings.map((b) => ({
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
        })),
        hasScreenshot: Boolean(b.paymentScreenshotKey),
        rejectionReason: b.rejectionReason,
        createdAt: b.createdAt.toISOString(),
      })),
      page: query.page,
      pageSize: PAGE_SIZE,
      total,
      totalPages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    });
  } catch (err) {
    return fail(err, { route: "GET /api/admin/bookings" });
  }
}

/**
 * Take a booking over the telephone.
 *
 * The request says only WHAT to book and who for. The slots are claimed through
 * the same hold-and-submit path a customer goes through, so this competes fairly
 * with the website: if a customer is paying for that 7 PM slot at this moment,
 * one of the two gets it and the other is told so. The price is read from the
 * schedule, never from this request.
 */
export async function POST(request: Request) {
  try {
    const admin = await requireAdmin();
    const input = adminBookingCreateSchema.parse(await readJson(request));

    const booking = await createManualBooking({
      resourceId: input.resourceId,
      date: input.date,
      startMin: input.startMin,
      endMin: input.endMin,
      overs: input.overs,
      ballTypeId: input.ballTypeId,
      customerName: input.customerName,
      customerPhone: input.customerPhone,
      amountPaid: input.amountPaid,
      note: input.note,
      admin,
    });

    await recordAudit(admin, "BOOKING_TAKEN_BY_STAFF", "booking", booking.reference, {
      date: booking.date,
      startMin: booking.startMin,
      endMin: booking.endMin,
      amount: booking.amount,
      collected: input.amountPaid,
    });

    return ok({
      booking: {
        id: booking._id.toHexString(),
        reference: booking.reference,
        locationName: booking.locationName,
        facilityName: booking.facilityName,
        resourceName: booking.resourceName,
        date: booking.date,
        startMin: booking.startMin,
        endMin: booking.endMin,
        overs: booking.overs,
        ballTypeName: booking.ballTypeName,
        amount: booking.amount,
        amountPaid: booking.amountPaid,
        customerName: booking.customerName,
        customerPhone: booking.customerPhone,
        status: booking.status,
      },
    });
  } catch (err) {
    return fail(err, { route: "POST /api/admin/bookings" });
  }
}
