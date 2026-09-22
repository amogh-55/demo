import { fail, ok, readJson } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { listBookings } from "@/lib/booking/admin-list";
import { createManualBooking } from "@/lib/booking/service";
import { adminBookingCreateSchema, adminBookingsQuerySchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

/** Paginated, filtered booking list. Every filter runs in the database, not the browser. */
export async function GET(request: Request) {
  try {
    await requireAdmin();
    const url = new URL(request.url);
    const query = adminBookingsQuerySchema.parse(Object.fromEntries(url.searchParams));
    return ok(await listBookings(query));
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
