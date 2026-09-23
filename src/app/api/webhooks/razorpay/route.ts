import { NextResponse } from "next/server";
import { fail, ok } from "@/lib/api";
import { recordFailedOnlinePayment, settleableFrom, settleRazorpayPayment } from "@/lib/booking/online-payment";
import { log } from "@/lib/log";
import { razorpayWebhookConfigured, verifyWebhookSignature, type RazorpayPayment } from "@/lib/razorpay";

export const dynamic = "force-dynamic";

/** A Razorpay webhook body is a couple of kilobytes. Anything larger is not one. */
const MAX_BODY_BYTES = 64 * 1024;

/**
 * Razorpay's own account of what happened, which is the half of the payment flow
 * that does not depend on the customer's phone still being switched on.
 *
 * This exists for the case the success callback cannot cover: the customer pays,
 * their train goes into a tunnel, and the browser never gets to tell us. The
 * webhook arrives regardless and confirms the booking, so a paid customer ends up
 * with a confirmed slot whether or not their connection survived the transaction.
 *
 * Nothing here trusts the body until the signature matches, and the signature is
 * computed over the RAW bytes — parsing first and re-serialising would produce a
 * different digest and a check that always fails, which is how this ends up
 * quietly disabled in a lot of integrations.
 *
 * Every outcome the handler understands answers 200, including duplicates and
 * events it ignores, because Razorpay retries anything else. A genuine failure on
 * our side answers 500 deliberately, so that a retry does happen.
 */
export async function POST(request: Request) {
  try {
    if (!razorpayWebhookConfigured()) {
      // With no secret nothing can be verified, so nothing can be believed. Said
      // out loud in the log, because a silently ignored webhook looks exactly
      // like a webhook that was never configured at Razorpay's end.
      log.error("razorpay_webhook_secret_missing");
      return NextResponse.json({ error: { code: "NOT_FOUND", message: "Not found" } }, { status: 404 });
    }

    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) {
      return NextResponse.json({ error: { code: "VALIDATION", message: "Body too large" } }, { status: 413 });
    }

    const signature = request.headers.get("x-razorpay-signature") ?? "";
    if (!signature || !verifyWebhookSignature(raw, signature)) {
      log.error("razorpay_webhook_signature_invalid", { bytes: raw.length });
      return NextResponse.json({ error: { code: "FORBIDDEN", message: "Invalid signature" } }, { status: 400 });
    }

    let event: { event?: string; payload?: { payment?: { entity?: RazorpayPayment } } };
    try {
      event = JSON.parse(raw);
    } catch {
      return NextResponse.json({ error: { code: "VALIDATION", message: "Malformed body" } }, { status: 400 });
    }

    const entity = event.payload?.payment?.entity;
    log.info("razorpay_webhook", { event: event.event, paymentId: entity?.id, orderId: entity?.order_id });

    switch (event.event) {
      case "payment.captured": {
        if (!entity?.id || !entity.order_id) break;
        // Idempotent by the payment id already on the booking, so a webhook
        // Razorpay retries five times settles the booking exactly once — and so
        // does a webhook that arrives after the browser already settled it.
        // Read through the same mapper the checkout path uses, so a bank reference
        // is validated identically wherever it came from.
        await settleRazorpayPayment(settleableFrom(entity), "webhook");
        break;
      }

      case "payment.failed": {
        if (!entity?.id || !entity.order_id) break;
        await recordFailedOnlinePayment({
          orderId: entity.order_id,
          paymentId: entity.id,
          reason: entity.error_description ?? null,
        });
        break;
      }

      default:
        // order.paid, refund.*, settlement.* and the rest. Acknowledged so
        // Razorpay stops retrying, acted on by nothing.
        break;
    }

    return ok({ received: true });
  } catch (err) {
    // 500 on purpose: Razorpay retries, and a database that was briefly down
    // should not cost a customer their confirmation.
    return fail(err, { route: "POST /api/webhooks/razorpay" });
  }
}
