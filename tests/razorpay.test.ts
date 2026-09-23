import assert from "node:assert/strict";
import crypto from "node:crypto";
import { beforeEach, describe, it } from "node:test";
import {
  fetchOrder,
  fetchOrderPayments,
  fetchPayment,
  razorpayConfigured,
  razorpayLiveMode,
  razorpayWebhookConfigured,
  referenceFromPayment,
  toPaise,
  toRupees,
  verifyCheckoutSignature,
  verifyWebhookSignature,
  type RazorpayPayment,
} from "../src/lib/razorpay";

const KEY_SECRET = "test_secret_do_not_use";
const WEBHOOK_SECRET = "webhook_secret_do_not_use";

beforeEach(() => {
  process.env.RAZORPAY_KEY_ID = "rzp_test_abcdef123456";
  process.env.RAZORPAY_KEY_SECRET = KEY_SECRET;
  process.env.RAZORPAY_WEBHOOK_SECRET = WEBHOOK_SECRET;
});

const checkoutSignature = (orderId: string, paymentId: string, secret = KEY_SECRET) =>
  crypto.createHmac("sha256", secret).update(`${orderId}|${paymentId}`).digest("hex");

/**
 * These two functions are the whole of what stands between "a browser said it
 * paid" and a confirmed booking. Everything else in the payment path is
 * bookkeeping; this is the part where being wrong means giving away slots.
 */
describe("the checkout signature", () => {
  it("accepts the signature Razorpay actually produces", () => {
    assert.equal(
      verifyCheckoutSignature({
        orderId: "order_ABC123",
        paymentId: "pay_XYZ789",
        signature: checkoutSignature("order_ABC123", "pay_XYZ789"),
      }),
      true,
    );
  });

  /** The attack this exists for: a real payment, re-pointed at a different order. */
  it("refuses a signature made for another order or another payment", () => {
    const signature = checkoutSignature("order_ABC123", "pay_XYZ789");
    assert.equal(verifyCheckoutSignature({ orderId: "order_OTHER", paymentId: "pay_XYZ789", signature }), false);
    assert.equal(verifyCheckoutSignature({ orderId: "order_ABC123", paymentId: "pay_OTHER", signature }), false);
  });

  it("refuses a signature made with a different secret", () => {
    const forged = checkoutSignature("order_ABC123", "pay_XYZ789", "somebody_elses_secret");
    assert.equal(verifyCheckoutSignature({ orderId: "order_ABC123", paymentId: "pay_XYZ789", signature: forged }), false);
  });

  /** timingSafeEqual throws on a length mismatch, which would be a 500, not a refusal. */
  it("refuses a malformed signature without throwing", () => {
    for (const signature of ["", "abc", "z".repeat(64), "0".repeat(128)]) {
      assert.equal(verifyCheckoutSignature({ orderId: "order_A", paymentId: "pay_B", signature }), false);
    }
  });

  it("refuses everything when no secret is configured", () => {
    process.env.RAZORPAY_KEY_SECRET = "";
    assert.equal(
      verifyCheckoutSignature({
        orderId: "order_ABC123",
        paymentId: "pay_XYZ789",
        signature: checkoutSignature("order_ABC123", "pay_XYZ789"),
      }),
      false,
    );
  });
});

describe("the webhook signature", () => {
  const body = JSON.stringify({ event: "payment.captured", payload: { payment: { entity: { id: "pay_1" } } } });
  const sign = (raw: string, secret = WEBHOOK_SECRET) =>
    crypto.createHmac("sha256", secret).update(raw).digest("hex");

  it("accepts a body signed with the webhook secret", () => {
    assert.equal(verifyWebhookSignature(body, sign(body)), true);
  });

  /**
   * The classic way this check gets quietly disabled: parse the body, re-stringify
   * it, and hash that. Key order and whitespace change, so the digest changes.
   */
  it("fails on a re-serialised body, which is why the raw text is what gets hashed", () => {
    const reserialised = JSON.stringify(JSON.parse(body.replace('{"event"', '{ "event"')));
    const padded = `{ "event": "payment.captured" }`;
    assert.equal(verifyWebhookSignature(padded, sign(reserialised)), false);
  });

  it("refuses a body signed with the API key secret instead of the webhook secret", () => {
    assert.equal(verifyWebhookSignature(body, sign(body, KEY_SECRET)), false);
  });

  it("refuses a tampered body", () => {
    const signature = sign(body);
    assert.equal(verifyWebhookSignature(body.replace("pay_1", "pay_2"), signature), false);
  });

  it("refuses everything when no webhook secret is configured", () => {
    process.env.RAZORPAY_WEBHOOK_SECRET = "";
    assert.equal(verifyWebhookSignature(body, sign(body)), false);
    assert.equal(razorpayWebhookConfigured(), false);
  });
});

describe("configuration", () => {
  it("needs both halves of the key pair", () => {
    assert.equal(razorpayConfigured(), true);
    process.env.RAZORPAY_KEY_SECRET = "";
    assert.equal(razorpayConfigured(), false);
    process.env.RAZORPAY_KEY_SECRET = KEY_SECRET;
    process.env.RAZORPAY_KEY_ID = "";
    assert.equal(razorpayConfigured(), false);
  });

  /** Shown in the admin screen. Getting it wrong is silent in both directions. */
  it("knows a live key from a test key", () => {
    assert.equal(razorpayLiveMode(), false);
    process.env.RAZORPAY_KEY_ID = "rzp_live_abcdef123456";
    assert.equal(razorpayLiveMode(), true);
  });
});

describe("money", () => {
  it("converts rupees to whole paise and back", () => {
    for (const rupees of [1, 100, 350, 700, 1200, 99_999]) {
      assert.equal(toPaise(rupees), rupees * 100);
      assert.equal(toRupees(toPaise(rupees)), rupees);
    }
  });

  /** 0.1 + 0.2 arithmetic has no place anywhere near a charge. */
  it("never produces a fractional paise", () => {
    assert.equal(toPaise(1234.005), 123401);
    assert.ok(Number.isInteger(toPaise(1199.99)));
  });
});

/**
 * "Razorpay has no such order" and "Razorpay would not answer me" look identical
 * from a failed HTTP call, and they mean opposite things: the first says nothing
 * was paid, the second says we do not know. The reclaim sweep gives a slot back
 * on the first and must never give one back on the second, so the distinction is
 * worth its own tests.
 */
describe("what Razorpay's failures are taken to mean", () => {
  const realFetch = globalThis.fetch;
  const reply = (status: number, body: unknown) => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as typeof fetch;
  };
  const restore = () => {
    globalThis.fetch = realFetch;
  };

  it("reads a 404 on an order's payments as 'nothing was paid'", async () => {
    reply(404, { error: { code: "BAD_REQUEST_ERROR", description: "The id provided does not exist" } });
    try {
      assert.deepEqual(await fetchOrderPayments("order_GONE"), []);
    } finally {
      restore();
    }
  });

  /** A key rotation makes old orders invisible. That must not be fatal. */
  it("reads a 404 on an order as 'no such order', not as an error", async () => {
    reply(404, { error: { description: "The id provided does not exist" } });
    try {
      assert.equal(await fetchOrder("order_GONE"), null);
    } finally {
      restore();
    }
  });

  /** Anything else is genuinely unknown, and unknown must never look like "unpaid". */
  it("throws on every other failure, so nothing is assumed about the money", async () => {
    for (const status of [401, 429, 500, 503]) {
      reply(status, { error: { description: "nope" } });
      try {
        await assert.rejects(() => fetchOrderPayments("order_1"), /payment provider/i, `status ${status}`);
        await assert.rejects(() => fetchOrder("order_1"), /payment provider/i, `status ${status}`);
      } finally {
        restore();
      }
    }
  });

  /** A payment id we asked about by name is different: missing there IS an error. */
  it("never silently swallows a missing payment", async () => {
    reply(404, { error: { description: "The id provided does not exist" } });
    try {
      await assert.rejects(() => fetchPayment("pay_GONE"), /payment provider/i);
    } finally {
      restore();
    }
  });

  it("returns the items of a successful lookup", async () => {
    reply(200, { items: [{ id: "pay_1", order_id: "order_1", status: "captured", amount: 70000, currency: "INR" }] });
    try {
      const items = await fetchOrderPayments("order_1");
      assert.equal(items.length, 1);
      assert.equal(items[0]!.id, "pay_1");
    } finally {
      restore();
    }
  });
});

describe("the bank reference on a payment", () => {
  const payment = (acquirer: RazorpayPayment["acquirer_data"]): RazorpayPayment => ({
    id: "pay_1",
    order_id: "order_1",
    status: "captured",
    amount: 70000,
    currency: "INR",
    acquirer_data: acquirer,
  });

  it("keeps a 12-digit UPI RRN, which is what the owner reconciles against", () => {
    assert.equal(referenceFromPayment(payment({ rrn: "123456789012" })), "123456789012");
  });

  /** A card payment has no RRN. Inventing something RRN-shaped would be worse than null. */
  it("gives null for anything that is not one", () => {
    assert.equal(referenceFromPayment(payment({ rrn: "12345" })), null);
    assert.equal(referenceFromPayment(payment({})), null);
    assert.equal(referenceFromPayment(payment(null)), null);
    assert.equal(referenceFromPayment(payment({ rrn: "12345678901a" })), null);
  });
});
