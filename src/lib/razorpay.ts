import "server-only";
import crypto from "node:crypto";
import { appError } from "./errors";
import { log } from "./log";

/**
 * Razorpay, over plain HTTPS.
 *
 * No SDK: every call this application makes is one authenticated POST or GET,
 * and the one piece of real cryptography — the signature check — is four lines of
 * node:crypto. A dependency here would only be a second place for the keys to live.
 *
 * Nothing in this file is reachable from the browser. RAZORPAY_KEY_SECRET and
 * RAZORPAY_WEBHOOK_SECRET are read from the server environment, are never
 * returned by any function, and are never logged. Only the key id — which the
 * checkout script needs in the page, and which is useless on its own — is public.
 */

const API = "https://api.razorpay.com/v1";
/** Razorpay is fast; a slow reply must not hold a customer's payment page open. */
const TIMEOUT_MS = 12_000;

export function razorpayKeyId(): string {
  return (process.env.RAZORPAY_KEY_ID || "").trim();
}

function keySecret(): string {
  return (process.env.RAZORPAY_KEY_SECRET || "").trim();
}

function webhookSecret(): string {
  return (process.env.RAZORPAY_WEBHOOK_SECRET || "").trim();
}

/** Whether orders can be created and payments checked. Without both, online payment is not offered. */
export function razorpayConfigured(): boolean {
  return Boolean(razorpayKeyId() && keySecret());
}

/** Whether webhooks can be trusted. A missing secret means every webhook is refused. */
export function razorpayWebhookConfigured(): boolean {
  return Boolean(webhookSecret());
}

/**
 * Test keys begin `rzp_test_`, live keys `rzp_live_`.
 *
 * Surfaced so the admin screen can say which one the deployment is on. Getting
 * this wrong is silent in both directions — test keys take no real money, live
 * keys take it from real customers — so it is worth showing rather than assuming.
 */
export function razorpayLiveMode(): boolean {
  return razorpayKeyId().startsWith("rzp_live_");
}

/** Rupees to the integer paise Razorpay works in. Money is never a float here. */
export function toPaise(rupees: number): number {
  return Math.round(rupees * 100);
}

/** Paise back to whole rupees. Every amount this application charges is a whole rupee. */
export function toRupees(paise: number): number {
  return Math.round(paise / 100);
}

function authHeader(): string {
  return `Basic ${Buffer.from(`${razorpayKeyId()}:${keySecret()}`).toString("base64")}`;
}

/**
 * One call to Razorpay, with the failure modes already turned into something a
 * customer can be shown.
 *
 * Razorpay reports its own errors in the body as `{ error: { description } }`,
 * and that description is written for a developer — "amount must be atleast INR
 * 1.00" is not something to put in front of somebody paying for a turf. The real
 * text is logged; the customer gets one sentence.
 */
async function call<T>(path: string, init?: RequestInit, options?: { nullOn404?: boolean }): Promise<T | null> {
  if (!razorpayConfigured()) {
    throw appError("INTERNAL", "Online payment is not set up on this site yet.");
  }

  let response: Response;
  try {
    response = await fetch(`${API}${path}`, {
      ...init,
      headers: {
        Authorization: authHeader(),
        "Content-Type": "application/json",
        ...init?.headers,
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    log.error("razorpay_unreachable", { path, err });
    throw appError("INTERNAL", "We could not reach the payment provider. Please try again in a moment.");
  }

  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }

  if (!response.ok) {
    const detail = (body as { error?: { description?: string; code?: string } } | null)?.error;
    log.error("razorpay_call_failed", {
      path,
      status: response.status,
      code: detail?.code,
      description: detail?.description,
    });
    /*
     * 404 is an answer, not a failure: Razorpay has no such order, so it
     * certainly holds no payment for it. Told apart from every other error
     * because the difference decides whether a slot can be given back.
     *
     * The case that makes this matter is the switch from test keys to live
     * ones. Orders raised under the old keys are invisible to the new ones, so
     * without this the slots of every booking that was mid-checkout at the
     * moment of the switch would be unreleasable for ever — each sweep asking
     * Razorpay, being refused, and conservatively leaving them alone.
     */
    if (options?.nullOn404 && response.status === 404) return null;
    throw appError("INTERNAL", "The payment provider refused that request. Please try again, or pay by UPI instead.");
  }

  return body as T;
}

export interface RazorpayOrder {
  id: string;
  amount: number;
  currency: string;
  status: string;
}

/**
 * An order is Razorpay's record of what we are asking for.
 *
 * The amount lives on it, on their side, which is exactly why the browser is
 * never asked what to charge: checkout can only pay an order for the amount that
 * order was created with, and that amount came from this server.
 */
export async function createOrder(input: {
  amountPaise: number;
  receipt: string;
  notes?: Record<string, string>;
}): Promise<RazorpayOrder> {
  return (await call<RazorpayOrder>("/orders", {
    method: "POST",
    body: JSON.stringify({
      amount: input.amountPaise,
      currency: "INR",
      // Razorpay caps the receipt at 40 characters and rejects the whole order
      // if it is longer, which a booking reference never is — but a change here
      // must not be able to break payments.
      receipt: input.receipt.slice(0, 40),
      // Auto-capture. Without it a payment sits "authorized", the customer's bank
      // shows the money gone, and Razorpay releases it days later — which reaches
      // the owner as an angry phone call rather than as a failed payment.
      payment_capture: 1,
      notes: input.notes ?? {},
    }),
  }))!;
}

export interface RazorpayPayment {
  id: string;
  order_id: string | null;
  /** created | authorized | captured | refunded | failed */
  status: string;
  amount: number;
  currency: string;
  method?: string;
  email?: string | null;
  contact?: string | null;
  /** UPI payments carry the bank reference the owner reconciles against. */
  acquirer_data?: { rrn?: string; upi_transaction_id?: string } | null;
  error_description?: string | null;
  created_at?: number;
}

/**
 * What Razorpay itself says about a payment.
 *
 * The browser's success callback is checked against this rather than believed. A
 * signature proves the callback was not tampered with; it does not prove the
 * payment succeeded, was made against this order, or was for the right amount.
 * Only Razorpay's own record does, so that is what a booking is settled from.
 */
export async function fetchPayment(paymentId: string): Promise<RazorpayPayment> {
  return (await call<RazorpayPayment>(`/payments/${encodeURIComponent(paymentId)}`))!;
}

/**
 * An order as Razorpay sees it. `status` is created, attempted or paid.
 *
 * Asked for before a customer is sent back into checkout, because "paid" is the
 * state where both the success callback and the webhook went missing — the money
 * left their account and nothing here knows. Reopening checkout on such an order
 * would show them a Razorpay error and leave them believing they have to pay
 * again, which is the single worst thing this integration could do.
 */
export async function fetchOrder(orderId: string): Promise<RazorpayOrder | null> {
  return call<RazorpayOrder>(`/orders/${encodeURIComponent(orderId)}`, undefined, { nullOn404: true });
}

/**
 * Every payment attempted against one order, successful or not.
 *
 * An order Razorpay does not have comes back as an empty list rather than an
 * error, because "no such order" and "no payments on that order" are the same
 * fact as far as anything here is concerned.
 */
export async function fetchOrderPayments(orderId: string): Promise<RazorpayPayment[]> {
  const body = await call<{ items?: RazorpayPayment[] }>(`/orders/${encodeURIComponent(orderId)}/payments`, undefined, {
    nullOn404: true,
  });
  return Array.isArray(body?.items) ? body.items : [];
}

/**
 * Capture an authorized payment.
 *
 * Only reached on an account where auto-capture is switched off — `payment_capture`
 * above covers the normal case. Kept because an uncaptured payment is money the
 * customer has lost and the owner has not received, and no amount of correct
 * booking state fixes that.
 */
export async function capturePayment(paymentId: string, amountPaise: number): Promise<RazorpayPayment> {
  return (await call<RazorpayPayment>(`/payments/${encodeURIComponent(paymentId)}/capture`, {
    method: "POST",
    body: JSON.stringify({ amount: amountPaise, currency: "INR" }),
  }))!;
}

/** Constant-time compare. Different lengths are simply not equal — timingSafeEqual would throw. */
function digestsMatch(expected: string, offered: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(offered, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * The signature Razorpay Checkout hands the browser: HMAC-SHA256 of
 * "<order_id>|<payment_id>", keyed with the API secret.
 *
 * It proves the success callback came from Razorpay and names this exact order
 * and payment, so a client cannot invent a payment id or replay one from another
 * booking. It does NOT prove the money arrived — {@link fetchPayment} is what
 * does that — so both are checked.
 */
export function verifyCheckoutSignature(input: { orderId: string; paymentId: string; signature: string }): boolean {
  if (!keySecret()) return false;
  const expected = crypto
    .createHmac("sha256", keySecret())
    .update(`${input.orderId}|${input.paymentId}`)
    .digest("hex");
  return digestsMatch(expected, input.signature);
}

/**
 * The webhook signature: HMAC-SHA256 of the RAW request body, keyed with the
 * webhook secret and sent as `x-razorpay-signature`.
 *
 * Raw, not re-serialised. JSON.parse followed by JSON.stringify reorders keys and
 * drops whitespace, and the digest of that is a different digest — which is how
 * webhook verification usually comes to be quietly skipped.
 */
export function verifyWebhookSignature(rawBody: string, signature: string): boolean {
  if (!webhookSecret()) return false;
  const expected = crypto.createHmac("sha256", webhookSecret()).update(rawBody).digest("hex");
  return digestsMatch(expected, signature);
}

/**
 * The bank reference for a UPI payment, when there is one.
 *
 * The owner reconciles their statement by this number, exactly as they do for a
 * payment sent with a screenshot, so it is stored in the same field. Card and
 * netbanking payments have no 12-digit RRN and get null, rather than something
 * that merely looks like one.
 */
export function referenceFromPayment(payment: RazorpayPayment): string | null {
  const rrn = payment.acquirer_data?.rrn;
  return typeof rrn === "string" && /^\d{12}$/.test(rrn) ? rrn : null;
}
