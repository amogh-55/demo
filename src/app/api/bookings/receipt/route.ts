import { cookies } from "next/headers";
import { fail, LAST_BOOKING_COOKIE } from "@/lib/api";
import { readSignedCookieValue } from "@/lib/auth";
import { collections, getDb } from "@/lib/db";
import { appError } from "@/lib/errors";
import { buildReceiptPdf, receiptAmount } from "@/lib/receipt-pdf";
import { getSettings } from "@/lib/settings";
import { formatBusinessDate, formatIstTimestamp, formatRange, minutesToDuration } from "@/lib/time";

export const dynamic = "force-dynamic";

/**
 * The customer's own receipt, as a PDF.
 *
 * Read from the same signed httpOnly cookie the success page uses, not from a
 * reference in the URL — otherwise anyone could download a stranger's receipt,
 * with their name and phone number on it, by guessing a booking reference.
 */
export async function GET() {
  try {
    const reference = readSignedCookieValue((await cookies()).get(LAST_BOOKING_COOKIE)?.value);
    if (!reference) throw appError("NOT_FOUND", "We could not find your booking on this device.");

    const db = await getDb();
    const booking = await collections.bookings(db).findOne({ reference });
    if (!booking) throw appError("NOT_FOUND", "We could not find your booking on this device.");

    const settings = await getSettings();
    const location = await collections.locations(db).findOne({ _id: booking.locationId });
    const dueNow = booking.amountDueNow ?? booking.amount;
    const atGround = Math.max(0, booking.amount - Math.max(booking.amountPaid, dueNow));
    const confirmed = booking.status === "CONFIRMED";

    const pdf = buildReceiptPdf({
      businessName: settings.businessName,
      heading: confirmed
        ? atGround > 0
          ? "Booking confirmed - balance payable at the ground"
          : "Booking confirmed"
        : "Booking request - awaiting payment verification",
      reference: booking.reference,
      lines: [
        { label: "Ground", value: booking.locationName },
        ...(location?.address ? [{ label: "Address", value: location.address }] : []),
        {
          label: "Booking",
          // A facility with one resource names it after itself, and "Box Cricket -
          // Box Cricket" reads as a mistake. Court 1 and Court 2 still earn theirs.
          value:
            booking.resourceName && booking.resourceName !== booking.facilityName
              ? `${booking.facilityName} - ${booking.resourceName}`
              : booking.facilityName,
        },
        ...(booking.overs ? [{ label: "Overs", value: `${booking.overs} overs` }] : []),
        ...(booking.ballTypeName ? [{ label: "Ball", value: booking.ballTypeName }] : []),
        { label: "Date", value: formatBusinessDate(booking.date) },
        { label: "Time", value: formatRange(booking.startMin, booking.endMin) },
        { label: "Duration", value: minutesToDuration(booking.endMin - booking.startMin) },
        { label: "Booking total", value: receiptAmount(booking.amount), strong: true },
        ...(booking.amountPaid > 0 ? [{ label: "Received", value: receiptAmount(booking.amountPaid) }] : []),
        ...(atGround > 0 ? [{ label: "To pay at the ground", value: receiptAmount(atGround), strong: true }] : []),
        { label: "Name", value: booking.customerName },
        { label: "Mobile", value: `+91 ${booking.customerPhone}` },
        { label: confirmed ? "Booked on" : "Requested on", value: `${formatIstTimestamp(booking.createdAt)} IST` },
      ],
      notes: [
        confirmed
          ? atGround > 0
            ? `This slot is confirmed. It is not a receipt for payment - ${receiptAmount(atGround)} is payable at the ground.`
            : "This slot is confirmed and paid in full."
          : "This document records a booking request only. It is not proof of a confirmed booking or of payment received.",
        ...(settings.supportPhone ? [`Queries: +91 ${settings.supportPhone}`] : []),
      ],
    });

    return new Response(new Uint8Array(pdf), {
      headers: {
        "Content-Type": "application/pdf",
        // `attachment` is what makes the browser save the file instead of
        // opening a viewer, which is the whole point of the button.
        "Content-Disposition": `attachment; filename="${booking.reference}.pdf"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    return fail(err, { route: "GET /api/bookings/receipt" });
  }
}
