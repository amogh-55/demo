/**
 * Razorpay Checkout, reduced to one promise.
 *
 * Their script is callback-shaped and stays on the page once loaded, which reads
 * badly inside a React flow: the success handler, the dismiss handler and the
 * failure event all have to agree about whether the customer is still paying.
 * Wrapping it so that opening checkout resolves exactly once, with one of three
 * outcomes, is what keeps the calling component to a single `await`.
 *
 * Nothing secret passes through here. The key id is public by design; the amount
 * is fixed by the order, which was created on the server, so nothing this file
 * hands Razorpay can change what the customer is charged.
 */

const SCRIPT_URL = "https://checkout.razorpay.com/v1/checkout.js";

export interface CheckoutSuccess {
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
}

export type CheckoutOutcome =
  | { kind: "PAID"; payload: CheckoutSuccess }
  /** The customer closed the window. Nothing has been charged. */
  | { kind: "DISMISSED" }
  /** Razorpay reported a failed attempt and the customer then closed the window. */
  | { kind: "FAILED"; message: string };

export interface CheckoutOptions {
  keyId: string;
  orderId: string;
  amountPaise: number;
  currency: string;
  businessName: string;
  description: string;
  prefill: { name: string; contact: string; email: string };
}

interface RazorpayInstance {
  open: () => void;
  on: (event: string, handler: (payload: unknown) => void) => void;
}

declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => RazorpayInstance;
  }
}

/** One load per page, shared by every attempt. A second <script> would re-register their globals. */
let loading: Promise<void> | null = null;

export function loadRazorpay(): Promise<void> {
  if (typeof window === "undefined") return Promise.reject(new Error("no window"));
  if (window.Razorpay) return Promise.resolve();
  if (loading) return loading;

  loading = new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SCRIPT_URL;
    script.async = true;
    script.onload = () => (window.Razorpay ? resolve() : reject(new Error("razorpay missing")));
    script.onerror = () => {
      // Cleared so a customer whose connection dropped can simply press pay again
      // rather than being stuck with a permanently rejected promise.
      loading = null;
      reject(new Error("razorpay script failed"));
    };
    document.body.appendChild(script);
  });
  return loading;
}

/**
 * Open checkout and wait for it to finish, however it finishes.
 *
 * `payment.failed` does not end anything — Razorpay keeps the window open so the
 * customer can try another card — so its message is remembered and reported only
 * if they then give up. Resolving on the failure event instead would tear the
 * window down underneath somebody who was about to succeed.
 */
export async function openRazorpayCheckout(options: CheckoutOptions): Promise<CheckoutOutcome> {
  await loadRazorpay();

  return new Promise<CheckoutOutcome>((resolve) => {
    let settled = false;
    let lastFailure: string | null = null;
    const finish = (outcome: CheckoutOutcome) => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };

    const rzp = new window.Razorpay!({
      key: options.keyId,
      order_id: options.orderId,
      amount: options.amountPaise,
      currency: options.currency,
      name: options.businessName,
      description: options.description,
      prefill: options.prefill,
      theme: { color: "#84cc16" },
      // Razorpay's own "retry" would reopen checkout behind our back, leaving this
      // promise resolved while the customer is still paying. Retrying is the
      // caller's job, from a button the customer can see.
      retry: { enabled: false },
      handler: (payload: CheckoutSuccess) => finish({ kind: "PAID", payload }),
      modal: {
        escape: true,
        ondismiss: () =>
          finish(lastFailure ? { kind: "FAILED", message: lastFailure } : { kind: "DISMISSED" }),
      },
    });

    rzp.on("payment.failed", (payload: unknown) => {
      const description = (payload as { error?: { description?: string } } | undefined)?.error?.description;
      lastFailure = description || "That payment did not go through.";
    });

    rzp.open();
  });
}
