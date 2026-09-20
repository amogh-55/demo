import { ObjectId } from "mongodb";
import { fail, ok, readJson } from "@/lib/api";
import { recordAudit, requireAdmin } from "@/lib/auth";
import {
  confirmBooking,
  recordManualPayment,
  recordWhatsappOpened,
  rejectBooking,
  reviewPayment,
} from "@/lib/booking/service";
import { collections, getDb } from "@/lib/db";
import { appError } from "@/lib/errors";
import { getSettings } from "@/lib/settings";
import type { BookingDoc } from "@/lib/types";
import { bookingActionSchema } from "@/lib/validation";
import { balanceRequestMessage, confirmationMessage, rejectionMessage, whatsappUrl } from "@/lib/whatsapp";

export const dynamic = "force-dynamic";

function parseId(raw: string): ObjectId {
  if (!ObjectId.isValid(raw)) throw appError("NOT_FOUND", "That booking no longer exists.");
  return new ObjectId(raw);
}

function serialise(b: BookingDoc) {
  return {
    id: b._id.toHexString(),
    reference: b.reference,
    locationId: b.locationId.toHexString(),
    locationName: b.locationName,
    date: b.date,
    startMin: b.startMin,
    endMin: b.endMin,
    unitStarts: b.unitStarts,
    amount: b.amount,
    priceBreakdown: b.priceBreakdown,
    customerName: b.customerName,
    customerPhone: b.customerPhone,
    status: b.status,
    paymentVerificationStatus: b.paymentVerificationStatus,
    amountPaid: b.amountPaid,
    amountRemaining: Math.max(0, b.amount - b.amountPaid),
    payments: (b.payments ?? []).map((p) => ({
      id: p.id,
      uploadedAt: p.uploadedAt.toISOString(),
      amount: p.amount,
      status: p.status,
      reviewedBy: p.reviewedBy,
      note: p.note,
      // The key itself is never exposed; the admin only needs to know a screenshot exists.
      hasScreenshot: Boolean(p.screenshotKey),
    })),
    hasScreenshot: Boolean(b.paymentScreenshotKey),
    paymentUploadedAt: b.paymentUploadedAt?.toISOString() ?? null,
    rejectionReason: b.rejectionReason,
    timeline: b.timeline.map((t) => ({ event: t.event, at: t.at.toISOString(), by: t.by, note: t.note ?? null })),
    createdAt: b.createdAt.toISOString(),
    updatedAt: b.updatedAt.toISOString(),
  };
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const admin = await requireAdmin();
    const id = parseId((await params).id);

    const db = await getDb();
    const booking = await collections.bookings(db).findOne({ _id: id }, { projection: { holdTokenHash: 0 } });
    if (!booking) throw appError("NOT_FOUND", "That booking no longer exists.");

    await recordAudit(admin, "BOOKING_VIEWED", "booking", booking.reference);
    return ok({ booking: serialise(booking as BookingDoc) });
  } catch (err) {
    return fail(err, { route: "GET /api/admin/bookings/[id]" });
  }
}

/**
 * Every state change goes through the booking service, which re-reads the booking
 * inside a transaction. Nothing here trusts the state the admin's browser saw.
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const admin = await requireAdmin();
    const id = parseId((await params).id);
    const action = bookingActionSchema.parse(await readJson(request));

    let booking: BookingDoc;
    switch (action.action) {
      case "ACCEPT_PAYMENT":
        booking = await reviewPayment({
          bookingId: id,
          attemptId: action.attemptId,
          accepted: true,
          amount: action.amount,
          note: action.note,
          admin,
        });
        await recordAudit(admin, "PAYMENT_VERIFIED", "booking", booking.reference, {
          recorded: action.amount,
          totalPaid: booking.amountPaid,
          expected: booking.amount,
          outcome: booking.paymentVerificationStatus,
        });
        break;

      case "REJECT_PAYMENT":
        // Deliberately does NOT release the slots — the customer can still pay.
        booking = await reviewPayment({
          bookingId: id,
          attemptId: action.attemptId,
          accepted: false,
          note: action.note,
          admin,
        });
        await recordAudit(admin, "PAYMENT_REJECTED", "booking", booking.reference, { note: action.note });
        break;

      case "RECORD_PAYMENT":
        booking = await recordManualPayment({
          bookingId: id,
          amount: action.amount,
          note: action.note,
          admin,
        });
        await recordAudit(admin, "PAYMENT_RECORDED_BY_STAFF", "booking", booking.reference, {
          recorded: action.amount,
          note: action.note,
          totalPaid: booking.amountPaid,
          expected: booking.amount,
          outcome: booking.paymentVerificationStatus,
        });
        break;

      case "CONFIRM":
        booking = await confirmBooking(id, admin);
        await recordAudit(admin, "BOOKING_CONFIRMED", "booking", booking.reference, {
          date: booking.date,
          startMin: booking.startMin,
          endMin: booking.endMin,
        });
        break;

      case "REJECT":
        booking = await rejectBooking(id, action.reason, admin);
        await recordAudit(admin, "BOOKING_REJECTED", "booking", booking.reference, { reason: action.reason });
        break;

      case "WHATSAPP_OPENED": {
        await recordWhatsappOpened(id, action.kind, admin);
        const db = await getDb();
        const found = await collections.bookings(db).findOne({ _id: id });
        if (!found) throw appError("NOT_FOUND", "That booking no longer exists.");
        booking = found;
        // Recorded as "opened", never "sent" — the admin still presses send themselves.
        await recordAudit(admin, `WHATSAPP_${action.kind}_OPENED`, "booking", booking.reference);
        break;
      }
    }

    return ok({ booking: serialise(booking) });
  } catch (err) {
    return fail(err, { route: "PATCH /api/admin/bookings/[id]" });
  }
}

/** Pre-filled WhatsApp link. Opening it is the admin's call; nothing is sent automatically. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireAdmin();
    const id = parseId((await params).id);
    const body = (await readJson(request)) as { kind?: string; reason?: string };
    const kind = body.kind === "REJECT" ? "REJECT" : body.kind === "BALANCE" ? "BALANCE" : "CONFIRM";

    const db = await getDb();
    const booking = await collections.bookings(db).findOne({ _id: id });
    if (!booking) throw appError("NOT_FOUND", "That booking no longer exists.");

    const [settings, location] = await Promise.all([
      getSettings(),
      collections.locations(db).findOne({ _id: booking.locationId }),
    ]);

    const base = {
      businessName: settings.businessName,
      reference: booking.reference,
      customerName: booking.customerName,
      locationName: booking.locationName,
      locationAddress: location?.address,
      date: booking.date,
      startMin: booking.startMin,
      endMin: booking.endMin,
      amount: booking.amount,
      supportPhone: settings.supportPhone,
    };

    const message =
      kind === "REJECT"
        ? rejectionMessage({ ...base, reason: body.reason || booking.rejectionReason || "Payment could not be verified" })
        : kind === "BALANCE"
          ? balanceRequestMessage({
              ...base,
              paid: booking.amountPaid,
              remaining: Math.max(0, booking.amount - booking.amountPaid),
            })
          : confirmationMessage(base);

    return ok({ url: whatsappUrl(booking.customerPhone, message), message });
  } catch (err) {
    return fail(err, { route: "POST /api/admin/bookings/[id]" });
  }
}
