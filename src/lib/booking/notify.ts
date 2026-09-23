import "server-only";
import { collections, getDb } from "@/lib/db";
import {
  customerBookingEmail,
  escapeHtml as esc,
  ownerBookingEmail,
  ownerEmail,
  resendConfigured,
  sendEmail,
  type BookingEmailFacts,
} from "@/lib/email";
import { log } from "@/lib/log";
import { getSettings } from "@/lib/settings";
import { formatBusinessDate, formatRange, minutesToDuration } from "@/lib/time";
import type { BookingDoc } from "@/lib/types";

/**
 * The confirmation email, sent once per booking.
 *
 * "Once" is the whole difficulty. A confirmed booking can be announced from three
 * places — the browser's success callback, the Razorpay webhook that says the same
 * thing a moment later, and an admin pressing Accept — and a customer who gets
 * three identical emails for one booking assumes they have been charged three
 * times. So the flag that records the send is flipped by a conditional update
 * first, and only the caller whose update actually modified the document goes on
 * to send. That is atomic across instances and across a retried webhook.
 */
export async function notifyBookingConfirmed(booking: BookingDoc): Promise<void> {
  if (!resendConfigured()) return;
  // Nothing to say to anyone: no owner address configured and no customer address
  // given. Checked before the flag is claimed so a later configuration fix still
  // has a booking to email about.
  if (!ownerEmail() && !booking.customerEmail) return;

  const db = await getDb();
  // `: null` matches a missing field as well as a null one, which is what every
  // booking made before this existed has.
  const claimed = await collections
    .bookings(db)
    .updateOne({ _id: booking._id, confirmationEmailAt: null }, { $set: { confirmationEmailAt: new Date() } });
  if (claimed.modifiedCount !== 1) return; // somebody else already sent it

  const [settings, location] = await Promise.all([
    getSettings(),
    collections.locations(db).findOne({ _id: booking.locationId }),
  ]);

  const paid = booking.amountPaid ?? 0;
  const remaining = Math.max(0, booking.amount - paid);
  const facts: BookingEmailFacts = {
    businessName: settings.businessName,
    reference: booking.reference,
    customerName: booking.customerName,
    customerPhone: booking.customerPhone,
    locationName: booking.locationName,
    locationAddress: location?.address,
    // "Box Cricket - Box Cricket" reads as a mistake; Court 1 and Court 2 earn theirs.
    service:
      booking.resourceName && booking.resourceName !== booking.facilityName
        ? `${booking.facilityName} - ${booking.resourceName}`
        : booking.facilityName,
    date: formatBusinessDate(booking.date),
    time: formatRange(booking.startMin, booking.endMin),
    duration:
      booking.overs !== null
        ? `${booking.overs} overs${booking.ballTypeName ? `, ${booking.ballTypeName}` : ""}`
        : minutesToDuration(booking.endMin - booking.startMin),
    amount: booking.amount,
    amountPaid: paid,
    amountRemaining: remaining,
    paymentMethod: describeMethod(booking),
    paymentStatus: booking.paymentVerificationStatus,
    supportPhone: settings.supportPhone,
  };

  // Sent in parallel and never awaited by the payment path that called this: an
  // email is a courtesy on top of money that has already arrived.
  const results = await Promise.all([
    ownerEmail() ? sendEmail({ to: ownerEmail(), ...ownerBookingEmail(facts) }) : Promise.resolve(false),
    booking.customerEmail
      ? sendEmail({ to: booking.customerEmail, ...customerBookingEmail(facts) })
      : Promise.resolve(false),
  ]);

  log.info("booking_emails_sent", { reference: booking.reference, owner: results[0], customer: results[1] });
}

/**
 * Money landed on a booking that is no longer live, so somebody has to refund it.
 *
 * Deliberately not idempotent and deliberately owner-only. This is the one thing
 * in the payment path nothing else in the system will surface on its own, and a
 * duplicate email about a refund owed is a far smaller problem than a missing one.
 */
export async function notifyPaymentNeedsAttention(booking: BookingDoc, amount: number): Promise<void> {
  const to = ownerEmail();
  if (!resendConfigured() || !to) {
    log.error("payment_needs_attention_unreported", { reference: booking.reference, amount, status: booking.status });
    return;
  }

  const settings = await getSettings();
  const lines = [
    `Booking ${booking.reference} is ${booking.status}, but a payment of ₹${amount.toLocaleString("en-IN")} has just been received for it.`,
    "",
    `Customer: ${booking.customerName} (+91 ${booking.customerPhone})`,
    `Ground: ${booking.locationName}`,
    `Slot: ${formatBusinessDate(booking.date)} ${formatRange(booking.startMin, booking.endMin)}`,
    "",
    "The slot is NOT reserved. Refund this payment from the Razorpay dashboard, or call the customer and re-book them.",
  ];

  await sendEmail({
    to,
    subject: `Action needed: payment received for ${booking.status.toLowerCase()} booking ${booking.reference}`,
    text: lines.join("\n"),
    html: `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px">
      <p style="margin:0 0 4px;font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#6b7280">${esc(settings.businessName)}</p>
      <h1 style="margin:0 0 12px;font-size:20px;color:#b91c1c">Payment received for a booking that is not live</h1>
      ${lines.map((l) => `<p style="margin:0 0 8px;font-size:14px;color:#374151">${esc(l)}</p>`).join("")}
    </div>`,
  });
}

/** What the email calls the payment, in the owner's words rather than the schema's. */
function describeMethod(booking: BookingDoc): string {
  if (booking.createdBy) return "Booked by phone";
  if (booking.payAtVenue) return "Pay at the ground";
  if (booking.paymentMethod === "RAZORPAY") {
    const method = (booking.payments ?? []).find((p) => p.provider === "RAZORPAY")?.razorpayMethod;
    return method ? `Razorpay (${method})` : "Razorpay";
  }
  return "UPI — verified by the turf team";
}
