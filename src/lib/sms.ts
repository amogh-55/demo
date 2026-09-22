import "server-only";
import { log } from "./log";

/**
 * Outbound SMS, behind one function.
 *
 * Which provider sends the message is an environment setting, not a code change,
 * because the owner has not picked one yet and the account will be theirs rather
 * than ours. Every provider here is a single HTTPS call — there is no SDK to
 * install and nothing to migrate if they switch.
 *
 * Nothing in this file is reachable from the browser: provider keys are read from
 * the server environment and the only exported function runs server-side.
 */
export type SmsProvider = "log" | "msg91" | "twilio";

export function smsProvider(): SmsProvider {
  const raw = (process.env.SMS_PROVIDER || "").trim().toLowerCase();
  if (raw === "msg91" || raw === "twilio") return raw;
  return "log";
}

/** True when a real provider is configured; false means messages only go to the log. */
export function smsConfigured(): boolean {
  switch (smsProvider()) {
    case "msg91":
      return Boolean(process.env.MSG91_AUTH_KEY && process.env.MSG91_SENDER_ID);
    case "twilio":
      return Boolean(
        process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM_NUMBER,
      );
    default:
      return false;
  }
}

/** 10 local digits to the E.164 form providers expect. */
function e164(phone: string): string {
  const digits = phone.replace(/\D/g, "").slice(-10);
  return `+91${digits}`;
}

async function postForm(url: string, body: URLSearchParams, headers: Record<string, string>): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
    body,
    // A slow provider must never hold a customer's booking request open.
    signal: AbortSignal.timeout(8000),
  });
}

/**
 * Send one SMS. Returns whether it left the building.
 *
 * Deliberately never throws: an OTP that could not be sent is reported to the
 * caller so it can say so, and a booking alert that failed must not take a
 * customer's booking down with it.
 */
export async function sendSms(phone: string, message: string): Promise<boolean> {
  const provider = smsProvider();
  const to = e164(phone);

  /*
   * A provider that is named but not fully configured is not a provider. Without
   * this, SMS_PROVIDER=msg91 with no sender ID posts to MSG91 on every booking
   * and every code, each one failing on their side — which reaches the owner as
   * an "SMS API Failed" alert rather than anything in our logs. Treated as
   * unconfigured, it behaves exactly as leaving SMS_PROVIDER blank does.
   */
  if (provider !== "log" && !smsConfigured()) {
    log.warn("sms_provider_incomplete", { provider });
    return false;
  }

  try {
    if (provider === "msg91") {
      const params = new URLSearchParams({
        authkey: process.env.MSG91_AUTH_KEY!,
        mobiles: to.replace("+", ""),
        message,
        sender: process.env.MSG91_SENDER_ID!,
        route: process.env.MSG91_ROUTE || "4",
        country: "91",
      });
      const res = await postForm("https://api.msg91.com/api/sendhttp.php", params, {});
      if (!res.ok) {
        log.error("sms_send_failed", { provider, status: res.status });
        return false;
      }
      return true;
    }

    if (provider === "twilio") {
      const sid = process.env.TWILIO_ACCOUNT_SID!;
      const auth = Buffer.from(`${sid}:${process.env.TWILIO_AUTH_TOKEN!}`).toString("base64");
      const params = new URLSearchParams({ To: to, From: process.env.TWILIO_FROM_NUMBER!, Body: message });
      const res = await postForm(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, params, {
        Authorization: `Basic ${auth}`,
      });
      if (!res.ok) {
        log.error("sms_send_failed", { provider, status: res.status });
        return false;
      }
      return true;
    }

    // No provider configured. The message is recorded so a developer can read a
    // one-time code during local testing; the number is logged but the body is
    // only printed outside production so a live log never carries live codes.
    log.info("sms_not_sent_no_provider", {
      to,
      ...(process.env.NODE_ENV === "production" ? {} : { message }),
    });
    return false;
  } catch (err) {
    log.error("sms_send_error", { err, provider });
    return false;
  }
}

/**
 * Tell the owner a booking arrived. Fire-and-forget on purpose: the customer's
 * request is already safely in the database and must not fail because an SMS did.
 */
export function notifyNewBooking(
  phone: string,
  booking: { reference: string; customerName: string; locationName: string; facilityName: string; when: string; amount: number },
): void {
  if (!phone) return;
  const message =
    `New booking ${booking.reference}: ${booking.customerName} — ` +
    `${booking.facilityName}, ${booking.locationName}, ${booking.when}. ` +
    `₹${booking.amount}. Verify the payment in the admin panel.`;
  void sendSms(phone, message).catch(() => {});
}
