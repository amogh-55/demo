import { cookies } from "next/headers";
import { fail, LAST_BOOKING_COOKIE, ok, readJson } from "@/lib/api";
import { signCookieValue } from "@/lib/auth";
import { settleableFrom, settleRazorpayPayment } from "@/lib/booking/online-payment";
import { appError } from "@/lib/errors";
import { log } from "@/lib/log";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import { capturePayment, fetchPayment, verifyCheckoutSignature } from "@/lib/razorpay";
import { razorpayVerifySchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

/**
 * The browser says a payment succeeded. This decides whether it actually did.
 *
 * Three separate things have to hold, and the first two are not enough on their
 * own:
 *
 *  1. The signature must check out. That proves the three ids came from Razorpay
 *     together and were not edited on the way here — so a client cannot invent a
 *     payment id, or borrow one from another booking.
 *  2. Razorpay's own record of the payment must name this order. A signature
 *     proves provenance, not outcome.
 *  3. That record must say the money was captured. A "success" callback fired by
 *     a modified page means nothing; a captured payment in Razorpay's ledger is
 *     the only thing that does.
 *
 * Only then is the booking settled — and settling is idempotent, so the webhook
 * saying the same thing a second later changes nothing.
 */
export async function POST(request: Request) {
  try {
    await rateLimit(`rzp-verify:${clientIp(request.headers)}`, 20, 60);

    const input = razorpayVerifySchema.parse(await readJson(request));

    if (
      !verifyCheckoutSignature({
        orderId: input.razorpay_order_id,
        paymentId: input.razorpay_payment_id,
        signature: input.razorpay_signature,
      })
    ) {
      // Logged loudly: a wrong signature is either a bug in our own flow or
      // somebody probing it, and neither should pass quietly.
      log.error("razorpay_signature_invalid", { orderId: input.razorpay_order_id });
      throw appError("FORBIDDEN", "We could not verify that payment. Please contact the ground before paying again.");
    }

    let payment = await fetchPayment(input.razorpay_payment_id);
    if (payment.order_id !== input.razorpay_order_id) {
      log.error("razorpay_payment_order_mismatch", {
        claimed: input.razorpay_order_id,
        actual: payment.order_id,
        paymentId: payment.id,
      });
      throw appError("FORBIDDEN", "That payment does not belong to this booking.");
    }

    /*
     * Auto-capture is asked for on every order, so this is the belt to that
     * braces — an account with auto-capture switched off would otherwise leave
     * the customer's money authorised and never taken, which their bank shows as
     * spent and the ground never receives.
     */
    if (payment.status === "authorized") {
      payment = await capturePayment(payment.id, payment.amount);
    }

    if (payment.status !== "captured") {
      throw appError(
        "CONFLICT",
        payment.status === "failed"
          ? "That payment did not go through. Nothing has been charged — please try again."
          : "We have not received that payment yet. Please wait a moment and refresh.",
      );
    }

    const booking = await settleRazorpayPayment(settleableFrom(payment), "checkout");
    if (!booking) {
      // The payment is real and captured but names an order no booking owns. Not
      // the customer's problem to solve, and not something a retry will fix.
      throw appError(
        "CONFLICT",
        "Your payment went through but we could not match it to a booking. Please call the ground with your payment id — you will not be charged again.",
      );
    }

    /*
     * Re-issued so the success page and the receipt work even when the original
     * cookie was lost — a different browser tab, an iOS in-app browser handing
     * back to Safari, cleared site data mid-payment. Nobody reaches this line
     * without a Razorpay-signed payment for this exact booking, so it names the
     * booking the caller just paid for and no other.
     */
    (await cookies()).set(LAST_BOOKING_COOKIE, signCookieValue(booking.reference), {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 7,
    });

    return ok({
      reference: booking.reference,
      status: booking.status,
      paymentVerificationStatus: booking.paymentVerificationStatus,
      amount: booking.amount,
      amountPaid: booking.amountPaid,
      amountRemaining: Math.max(0, booking.amount - booking.amountPaid),
    });
  } catch (err) {
    return fail(err, { route: "POST /api/payments/razorpay/verify" });
  }
}
