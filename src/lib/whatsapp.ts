import { formatBusinessDate, formatRange } from "./time";

/** wa.me needs digits with country code and no plus. */
export function normaliseWhatsappNumber(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 10) return `91${digits}`;
  if (digits.length === 12 && digits.startsWith("91")) return digits;
  if (digits.length === 13 && digits.startsWith("091")) return digits.slice(1);
  return digits;
}

export function whatsappUrl(phone: string, message: string): string {
  return `https://wa.me/${normaliseWhatsappNumber(phone)}?text=${encodeURIComponent(message)}`;
}

export interface BookingMessageInput {
  reference: string;
  customerName: string;
  locationName: string;
  locationAddress?: string;
  date: string;
  startMin: number;
  endMin: number;
  amount: number;
  supportPhone?: string;
}

/** "₹1,200", in the grouping an Indian customer reads. */
const rupees = (amount: number) => `₹${amount.toLocaleString("en-IN")}`;

export function confirmationMessage(
  b: BookingMessageInput & {
    /** What has actually been received so far. Defaults to the full amount. */
    paid?: number;
  },
): string {
  const received = Number.isFinite(b.paid as number) ? (b.paid as number) : b.amount;
  const remaining = Math.max(0, b.amount - received);

  /*
   * A booking taken over the telephone is confirmed with only the advance in
   * hand, so "Amount: ₹800" on its own is the wrong number twice over: it is
   * neither what they paid nor what they owe. Saying all three means nobody
   * turns up at the gate arguing about the balance.
   */
  const amountLines =
    remaining > 0
      ? [
          `Total: ${rupees(b.amount)}`,
          ...(received > 0 ? [`Advance received: ${rupees(received)}`] : []),
          `*Balance left: ${rupees(remaining)}*`,
        ]
      : [`Amount paid: ${rupees(b.amount)}`];

  return [
    `Hi ${b.customerName}, your cricket turf booking is confirmed. ✅`,
    ``,
    `Booking ID: ${b.reference}`,
    `Location: ${b.locationName}`,
    ...(b.locationAddress ? [`Address: ${b.locationAddress}`] : []),
    `Date: ${formatBusinessDate(b.date)}`,
    `Time: ${formatRange(b.startMin, b.endMin)}`,
    ...amountLines,
    ``,
    `Please arrive 10 minutes early. See you!`,
  ].join("\n");
}

/**
 * Asks for the shortfall without cancelling anything. Deliberately reassures the
 * customer that their slot is still held, because it is.
 */
export function balanceRequestMessage(b: BookingMessageInput & { paid: number; remaining: number }): string {
  return [
    `Hi ${b.customerName}, thanks for your payment for booking ${b.reference}.`,
    ``,
    `Location: ${b.locationName}`,
    `Date: ${formatBusinessDate(b.date)}`,
    `Time: ${formatRange(b.startMin, b.endMin)}`,
    ``,
    `Total: ${rupees(b.amount)}`,
    `Received: ${rupees(b.paid)}`,
    `*Balance due: ${rupees(b.remaining)}*`,
    ``,
    `Your slot is still held for you. Please send the balance and share the screenshot, and we will confirm your booking.`,
  ].join("\n");
}

export function rejectionMessage(b: BookingMessageInput & { reason: string }): string {
  return [
    `Hi ${b.customerName}, unfortunately your booking request ${b.reference} could not be confirmed.`,
    ``,
    `Location: ${b.locationName}`,
    `Date: ${formatBusinessDate(b.date)}`,
    `Time: ${formatRange(b.startMin, b.endMin)}`,
    ``,
    `Reason: ${b.reason}`,
    ``,
    ...(b.supportPhone ? [`Please contact us on ${b.supportPhone} if you need assistance.`] : ["Please contact us if you need assistance."]),
  ].join("\n");
}

export interface BookedServiceInput {
  facilityName: string;
  resourceName: string;
  /** OVERS facilities only: what the customer actually bought. */
  overs?: number | null;
  ballTypeName?: string | null;
}

/**
 * What was booked, phrased the way the customer would say it: "20 overs on
 * Bowling Machine (Leather ball)", or "Pickleball Court 2".
 *
 * The court is named only where it differs from the facility, because every
 * single-court facility names its one resource after itself and "Nets Nets"
 * helps nobody.
 */
export function serviceLabel(b: BookedServiceInput): string {
  const facility = b.facilityName?.trim() || "the ground";
  const resource = b.resourceName?.trim();
  const what = resource && resource !== facility ? `${facility} ${resource}` : facility;
  const ball = b.ballTypeName?.trim() ? ` (${b.ballTypeName.trim()})` : "";
  // Overs are the unit the customer bought, so they lead; the clock time still
  // follows, because a bowling session is booked into a slot like anything else.
  return b.overs && b.overs > 0 ? `${b.overs} overs on ${what}${ball}` : `${what}${ball}`;
}

/**
 * The message the customer sends from the success page.
 *
 * It has to stand on its own in the turf's WhatsApp inbox, which is why it
 * names the person, the ground, the service and the time rather than only the
 * reference — a reference means nothing to whoever picks up the phone until
 * they have gone and looked it up.
 */
export function customerIntroMessage(
  b: BookedServiceInput &
    Pick<BookingMessageInput, "reference" | "customerName" | "locationName" | "date" | "startMin" | "endMin">,
): string {
  return [
    `Hi, I am ${b.customerName}.`,
    `I booked ${serviceLabel(b)} at ${b.locationName} on ${formatBusinessDate(b.date)}, ${formatRange(b.startMin, b.endMin)}.`,
    ``,
    `Booking ID: ${b.reference}`,
  ].join("\n");
}
