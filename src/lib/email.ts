import "server-only";
import { log } from "./log";

/**
 * Outbound email, through Resend.
 *
 * One HTTPS call, so there is no SDK here for the same reason there is none for
 * SMS or for Razorpay: the account is the client's, the call is four lines, and a
 * dependency would only be somewhere else for the key to live.
 *
 * Nothing here ever throws. An email is a courtesy on top of a booking that has
 * already been paid for and confirmed — a provider having a bad minute must not
 * turn that into a failed payment.
 */

const ENDPOINT = "https://api.resend.com/emails";
const TIMEOUT_MS = 8000;

export function resendConfigured(): boolean {
  return Boolean((process.env.RESEND_API_KEY || "").trim() && (process.env.RESEND_FROM_EMAIL || "").trim());
}

/** Where the owner's copy goes. Blank means the owner simply does not get one. */
export function ownerEmail(): string {
  return (process.env.OWNER_EMAIL || "").trim();
}

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

/**
 * Send one email. Returns whether it left the building.
 *
 * Deliberately never throws, and deliberately never logs the body: a booking
 * confirmation carries a customer's name and phone number, and a log line is the
 * easiest place in a system for those to end up somewhere they should not.
 */
export async function sendEmail(message: EmailMessage): Promise<boolean> {
  if (!resendConfigured()) {
    log.info("email_skipped_not_configured", { subject: message.subject });
    return false;
  }
  if (!message.to) return false;

  try {
    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${(process.env.RESEND_API_KEY || "").trim()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: (process.env.RESEND_FROM_EMAIL || "").trim(),
        to: [message.to],
        subject: message.subject,
        html: message.html,
        text: message.text,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!response.ok) {
      // Resend puts the reason in the body, and it is the difference between "the
      // domain is not verified" and "that address bounced" — both of which the
      // owner has to fix, and neither of which is visible from a status code.
      const detail = await response.text().catch(() => "");
      log.error("email_send_failed", { status: response.status, detail: detail.slice(0, 300) });
      return false;
    }

    log.info("email_sent", { subject: message.subject });
    return true;
  } catch (err) {
    log.error("email_send_error", { err });
    return false;
  }
}

/* ──────────────────────────────────────────────────────────────────────────
 * Templates
 * ────────────────────────────────────────────────────────────────────── */

/** Everything a confirmation email states. Assembled by the caller from the booking. */
export interface BookingEmailFacts {
  businessName: string;
  reference: string;
  customerName: string;
  customerPhone: string;
  locationName: string;
  locationAddress?: string;
  service: string;
  date: string;
  time: string;
  duration: string;
  amount: number;
  amountPaid: number;
  amountRemaining: number;
  paymentMethod: string;
  paymentStatus: string;
  supportPhone?: string;
}

const rupees = (n: number) => `₹${n.toLocaleString("en-IN")}`;

/** HTML-escape. Customer names are user input and end up inside a document. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function rows(facts: BookingEmailFacts): Array<[string, string]> {
  return [
    ["Booking ID", facts.reference],
    ["Customer", facts.customerName],
    ["Phone", `+91 ${facts.customerPhone}`],
    ["Ground", facts.locationAddress ? `${facts.locationName} — ${facts.locationAddress}` : facts.locationName],
    ["Booking", facts.service],
    ["Date", facts.date],
    ["Time", facts.time],
    ["Duration", facts.duration],
    ["Total", rupees(facts.amount)],
    ["Paid", rupees(facts.amountPaid)],
    ["Balance", facts.amountRemaining > 0 ? `${rupees(facts.amountRemaining)} — payable at the ground` : rupees(0)],
    ["Payment method", facts.paymentMethod],
    ["Payment status", facts.paymentStatus],
  ];
}

/**
 * The same facts, laid out twice.
 *
 * A table in inlined styles rather than a stylesheet, because email clients strip
 * <style> blocks; and a plain-text part alongside it, because some of them show
 * only that. Neither is decorative — this is the document a customer holds up at
 * the gate.
 */
function render(facts: BookingEmailFacts, heading: string, lead: string): { html: string; text: string } {
  const body = rows(facts)
    .map(
      ([label, value]) =>
        `<tr><td style="padding:6px 12px 6px 0;color:#6b7280;font-size:14px;white-space:nowrap">${escapeHtml(label)}</td>` +
        `<td style="padding:6px 0;color:#111827;font-size:14px;font-weight:600">${escapeHtml(value)}</td></tr>`,
    )
    .join("");

  const html =
    `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px">` +
    `<p style="margin:0 0 4px;font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#6b7280">${escapeHtml(facts.businessName)}</p>` +
    `<h1 style="margin:0 0 8px;font-size:22px;color:#111827">${escapeHtml(heading)}</h1>` +
    `<p style="margin:0 0 20px;font-size:15px;color:#374151">${escapeHtml(lead)}</p>` +
    `<table style="border-collapse:collapse;width:100%">${body}</table>` +
    (facts.supportPhone
      ? `<p style="margin:20px 0 0;font-size:13px;color:#6b7280">Questions? Call +91 ${escapeHtml(facts.supportPhone)}.</p>`
      : "") +
    `</div>`;

  const text = [
    facts.businessName,
    heading,
    "",
    lead,
    "",
    ...rows(facts).map(([label, value]) => `${label}: ${value}`),
    ...(facts.supportPhone ? ["", `Questions? Call +91 ${facts.supportPhone}.`] : []),
  ].join("\n");

  return { html, text };
}

/** The owner's copy: a new confirmed booking to put on the board. */
export function ownerBookingEmail(facts: BookingEmailFacts): Omit<EmailMessage, "to"> {
  const { html, text } = render(
    facts,
    "New confirmed booking",
    // Not "online": a phone booking's money was taken in cash or UPI on the
    // call, and a pay-at-the-ground one has none yet.
    facts.amountRemaining <= 0
      ? `${facts.customerName} has paid in full.`
      : facts.amountPaid > 0
        ? `${facts.customerName} has paid ${rupees(facts.amountPaid)}. ${rupees(facts.amountRemaining)} is to be collected at the ground.`
        : `Nothing paid yet. ${rupees(facts.amountRemaining)} is to be collected at the ground.`,
  );
  return {
    subject: `${facts.reference} — ${facts.date} ${facts.time} — ${facts.locationName}`,
    html,
    text,
  };
}

/** The customer's copy: proof, and what to bring. */
export function customerBookingEmail(facts: BookingEmailFacts): Omit<EmailMessage, "to"> {
  const { html, text } = render(
    facts,
    "Your booking is confirmed",
    facts.amountRemaining > 0
      ? `Thanks, ${facts.customerName}. Your slot is reserved. Please bring ${rupees(facts.amountRemaining)} to pay at the ground.`
      : `Thanks, ${facts.customerName}. Your slot is reserved and paid in full. Just turn up.`,
  );
  return {
    subject: `Booking confirmed — ${facts.reference} — ${facts.date} ${facts.time}`,
    html,
    text,
  };
}
