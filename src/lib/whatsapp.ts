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
  businessName: string;
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

export function confirmationMessage(b: BookingMessageInput): string {
  return [
    `Hi ${b.customerName}, your cricket turf booking is confirmed. ✅`,
    ``,
    `Booking ID: ${b.reference}`,
    `Location: ${b.locationName}`,
    ...(b.locationAddress ? [`Address: ${b.locationAddress}`] : []),
    `Date: ${formatBusinessDate(b.date)}`,
    `Time: ${formatRange(b.startMin, b.endMin)}`,
    `Amount: ₹${b.amount.toLocaleString("en-IN")}`,
    ``,
    `Please arrive 10 minutes early. See you at ${b.businessName}!`,
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
    `Total: ₹${b.amount.toLocaleString("en-IN")}`,
    `Received: ₹${b.paid.toLocaleString("en-IN")}`,
    `*Balance due: ₹${b.remaining.toLocaleString("en-IN")}*`,
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
