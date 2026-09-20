import { ObjectId, type Filter } from "mongodb";
import { fail, ok } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { collections, getDb } from "@/lib/db";
import { isValidBusinessDate } from "@/lib/time";
import type { BookingDoc } from "@/lib/types";
import { adminBookingsQuerySchema } from "@/lib/validation";

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
          hasScreenshot: Boolean(p.screenshotKey),
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
