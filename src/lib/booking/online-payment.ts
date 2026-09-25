import "server-only";
import crypto from "node:crypto";
import type { ObjectId } from "mongodb";
import { collections, getDb } from "@/lib/db";
import { appError } from "@/lib/errors";
import { log } from "@/lib/log";
import {
  createOrder,
  fetchOrder,
  fetchOrderPayments,
  razorpayKeyId,
  referenceFromPayment,
  toPaise,
  toRupees,
  type RazorpayPayment,
} from "@/lib/razorpay";
import { getSettings } from "@/lib/settings";
import type { BookingDoc, PaymentAttempt } from "@/lib/types";
import { notifyPaymentNeedsAttention } from "./notify";
import { confirmBooking, paymentRollupStages, rejectBooking } from "./service";

/**
 * Taking money through Razorpay, and turning it into a confirmed booking.
 *
 * The order of events is the whole design. The BOOKING IS CREATED FIRST, holding
 * its slots as PENDING with nothing paid, and only then is an order raised
 * against it. That is the opposite of the obvious arrangement — pay, then book —
 * and it is chosen because of which failure it makes impossible: money can never
 * arrive for a booking that does not exist. Every settlement path below therefore
 * only ever finds a booking and adds money to it; none of them creates one, and
 * none of them can create one twice.
 *
 * What it costs is the opposite case: somebody who opens checkout and walks away
 * leaves a slot reserved and unpaid. {@link reclaimAbandonedOnlinePayments} is
 * what takes those back, and it asks Razorpay first rather than assuming.
 */

/**
 * How long a booking may sit waiting for an online payment before its slots go
 * back on sale.
 *
 * Fifteen minutes, not five: a UPI collect request can genuinely take a couple of
 * minutes to reach the customer's bank app, and somebody typing a card number on
 * a phone at a ground is slower than somebody doing it at a desk. The cost of
 * being generous is one slot held a little longer; the cost of being mean is
 * taking a slot away from a customer who is midway through paying for it.
 */
export const ONLINE_PAYMENT_GRACE_MINUTES = 15;

/** What the browser needs to open Razorpay Checkout. No secret appears here. */
export interface OnlineOrder {
  keyId: string;
  orderId: string;
  amountPaise: number;
  currency: "INR";
  reference: string;
  /** The same figure in rupees, for what the page says beside the button. */
  amount: number;
}

export type StartOnlinePaymentResult =
  | { kind: "ORDER"; order: OnlineOrder }
  /** The money was already taken — show the booking, do not charge again. */
  | { kind: "ALREADY_PAID"; booking: BookingDoc };

/**
 * Raise (or recover) the charge for a booking that is waiting to be paid online.
 *
 * The amount is computed here from the booking's own stored figures and nothing
 * else. The browser cannot name it, cannot round it, and cannot pay a rupee less:
 * Razorpay will only accept a payment equal to the order it was created for, and
 * that order is created on this side of the wire.
 */
export async function startOnlinePayment(booking: BookingDoc): Promise<StartOnlinePaymentResult> {
  if (booking.paymentMethod !== "RAZORPAY") {
    throw appError("CONFLICT", "This booking is not set up for online payment.");
  }
  if (booking.status !== "PENDING") {
    throw appError(
      "CONFLICT",
      booking.status === "CONFIRMED"
        ? "This booking is already confirmed."
        : `This booking is ${booking.status.toLowerCase()} and can no longer be paid for.`,
    );
  }

  const dueNow = booking.amountDueNow ?? booking.amount;
  const outstanding = dueNow - (booking.amountPaid ?? 0);
  // Belt and braces against the rule in the brief: never charge more than is owed,
  // and never charge zero or less. Both are arithmetic on stored figures, so
  // neither can be reached from a request — which is the point of asserting them.
  if (outstanding <= 0) return { kind: "ALREADY_PAID", booking };
  if (outstanding > booking.amount) {
    log.error("razorpay_amount_exceeds_total", { reference: booking.reference, outstanding, amount: booking.amount });
    throw appError("INTERNAL", "We could not work out what to charge. Please call the ground.");
  }

  const existingId = booking.razorpayOrderIds?.[booking.razorpayOrderIds.length - 1];
  if (existingId) {
    // Null when Razorpay has no such order — which happens after a key rotation
    // or a switch between test and live mode. A fresh one is raised below.
    const order = await fetchOrder(existingId);
    /*
     * The customer already paid and we never heard about it — the callback was
     * lost, the tab was closed, the webhook has not landed. Settling it here is
     * what turns "I paid and nothing happened" into a confirmed booking, and it
     * is why this check comes before any new order is raised.
     */
    if (order?.status === "paid") {
      const settled = await recoverPaidOrder(existingId);
      if (settled) return { kind: "ALREADY_PAID", booking: settled };
    } else if (order && order.amount === toPaise(outstanding)) {
      // Unpaid and still for the right money: reopen the same order rather than
      // stacking up a new one per press of the button.
      return { kind: "ORDER", order: publicOrder(order.id, order.amount, booking) };
    }
  }

  const order = await createOrder({
    amountPaise: toPaise(outstanding),
    receipt: booking.reference,
    // Visible in the Razorpay dashboard, which is where the owner will stand when
    // a customer rings up about a payment.
    notes: {
      reference: booking.reference,
      ground: booking.locationName.slice(0, 60),
      date: booking.date,
    },
  });

  const db = await getDb();
  await collections
    .bookings(db)
    .updateOne({ _id: booking._id }, { $push: { razorpayOrderIds: order.id }, $set: { updatedAt: new Date() } });

  log.info("razorpay_order_created", { reference: booking.reference, orderId: order.id, amount: outstanding });
  return { kind: "ORDER", order: publicOrder(order.id, order.amount, booking) };
}

function publicOrder(orderId: string, amountPaise: number, booking: BookingDoc): OnlineOrder {
  return {
    keyId: razorpayKeyId(),
    orderId,
    amountPaise,
    currency: "INR",
    reference: booking.reference,
    amount: toRupees(amountPaise),
  };
}

/** The fields of a Razorpay payment this application actually acts on. */
export interface SettleablePayment {
  paymentId: string;
  orderId: string;
  amountPaise: number;
  method?: string | null;
  /** The bank reference for a UPI payment, when Razorpay reported one. */
  rrn?: string | null;
}

export function settleableFrom(payment: RazorpayPayment): SettleablePayment {
  return {
    paymentId: payment.id,
    orderId: payment.order_id ?? "",
    amountPaise: payment.amount,
    method: payment.method ?? null,
    rrn: referenceFromPayment(payment),
  };
}

/**
 * Record one captured Razorpay payment against its booking, and confirm the
 * booking if that payment covers what was due. Safe to call any number of times
 * with the same payment.
 *
 * Exactly-once is enforced by the database, not by checking first and writing
 * after. The update's filter says "this booking, provided it does not already
 * carry this payment id", and MongoDB evaluates that filter under the document's
 * own lock — so of two requests describing the same payment (the browser's
 * callback and the webhook, which routinely arrive within a second of each
 * other), precisely one writes and the other finds nothing to do.
 */
export async function settleRazorpayPayment(
  payment: SettleablePayment,
  source: "checkout" | "webhook" | "recovery",
): Promise<BookingDoc | null> {
  if (!payment.orderId || !payment.paymentId) {
    log.error("razorpay_settle_missing_ids", { source });
    return null;
  }

  const db = await getDb();
  const booking = await collections.bookings(db).findOne({ razorpayOrderIds: payment.orderId });
  if (!booking) {
    /*
     * A payment for an order this database has never heard of. It cannot be
     * settled and retrying will not help, so the webhook is answered 200 and this
     * line is the record — the owner refunds it from the Razorpay dashboard.
     */
    log.error("razorpay_order_unknown", { source, orderId: payment.orderId, paymentId: payment.paymentId });
    return null;
  }

  const now = new Date();
  const amount = toRupees(payment.amountPaise);
  const attempt: PaymentAttempt = {
    id: crypto.randomUUID(),
    screenshotKey: null,
    // There is no image to lose: the gateway is the evidence.
    uploadStatus: "NONE",
    uploadFailureReason: null,
    // A UPI payment through Razorpay has the same 12-digit bank reference a
    // customer would have typed off their own app, so it goes in the same field
    // and the owner reconciles it exactly the same way.
    utr: payment.rrn ?? null,
    uploadedAt: now,
    amount,
    // Accepted on Razorpay's word, not an admin's. Nobody is asked to look at a
    // screenshot for money the gateway has already captured.
    status: "ACCEPTED",
    reviewedBy: "razorpay",
    reviewedAt: now,
    note: `Paid online via Razorpay${payment.method ? ` (${payment.method})` : ""}`,
    provider: "RAZORPAY",
    razorpayOrderId: payment.orderId,
    razorpayPaymentId: payment.paymentId,
    razorpayMethod: payment.method ?? null,
  };

  const updated = await collections.bookings(db).findOneAndUpdate(
    { _id: booking._id, "payments.razorpayPaymentId": { $ne: payment.paymentId } },
    [
      {
        $set: {
          payments: { $concatArrays: [{ $ifNull: ["$payments", []] }, [{ $literal: attempt }]] },
          timeline: {
            $concatArrays: [
              { $ifNull: ["$timeline", []] },
              [
                {
                  $literal: {
                    event: "ONLINE_PAYMENT_RECEIVED",
                    at: now,
                    by: "razorpay",
                    note: `${amount} received (${payment.paymentId})`,
                  },
                },
              ],
            ],
          },
        },
      },
      // The same arithmetic a reviewed screenshot goes through. Gateway money and
      // counter money must land in the same place or the totals stop agreeing.
      ...paymentRollupStages(now),
    ],
    { returnDocument: "after" },
  );

  if (!updated) {
    log.info("razorpay_payment_already_settled", { source, reference: booking.reference, paymentId: payment.paymentId });
  } else {
    log.info("razorpay_payment_recorded", {
      source,
      reference: updated.reference,
      amount,
      amountPaid: updated.amountPaid,
      paymentStatus: updated.paymentVerificationStatus,
    });
  }

  const current = updated ?? (await collections.bookings(db).findOne({ _id: booking._id }));
  if (!current) return null;

  const dueNow = current.amountDueNow ?? current.amount;
  if (current.status === "PENDING" && (current.amountPaid ?? 0) >= dueNow) {
    // Idempotent: a booking already confirmed by the other caller comes straight
    // back out, and the slots move PENDING -> BOOKED exactly once.
    // The owner hears about it by email, from confirmBooking itself, and only
    // once however many times this runs.
    return await confirmBooking(current._id, { username: "razorpay" });
  }

  /*
   * Money arrived against a booking that is no longer live — the reclaim sweep
   * released it moments before the payment landed, or an admin rejected it. The
   * payment is recorded either way, because it really happened, and the owner is
   * told at once: this is a refund, and nothing else in the system will raise it.
   */
  if (current.status !== "PENDING" && current.status !== "CONFIRMED") {
    log.error("razorpay_payment_on_dead_booking", {
      source,
      reference: current.reference,
      status: current.status,
      amount,
    });
    void notifyPaymentNeedsAttention(current, amount).catch(() => {});
  }

  return current;
}

/**
 * A payment that did not go through: a declined card, a UPI request the customer
 * let time out, a wrong PIN.
 *
 * Nothing about the booking changes — the slots stay reserved and the customer is
 * free to try again — but it is written into the timeline, because "I tried three
 * times and it kept failing" is a thing customers ring up about and the owner
 * currently has no way to see.
 */
export async function recordFailedOnlinePayment(input: {
  orderId: string;
  paymentId: string;
  reason?: string | null;
}): Promise<void> {
  const db = await getDb();
  const result = await collections.bookings(db).updateOne(
    { razorpayOrderIds: input.orderId, status: "PENDING" },
    {
      $push: {
        timeline: {
          event: "ONLINE_PAYMENT_FAILED",
          at: new Date(),
          by: "razorpay",
          note: (input.reason || "Payment failed").slice(0, 200),
        },
      },
    },
  );
  log.info("razorpay_payment_failed", {
    orderId: input.orderId,
    paymentId: input.paymentId,
    matched: result.matchedCount,
  });
}

/**
 * The customer walked away from an online booking they never paid for — pressed
 * Change slot after a failed or cancelled checkout.
 *
 * Pressing Pay turned their hold into a booking, so the slot belongs to that
 * booking now and releasing the hold frees nothing. Left alone it would sit
 * "On hold" for nobody until the sweep, and the customer who just let it go
 * would read it as somebody else's.
 *
 * Razorpay is asked first, exactly as the sweep does: a payment that did land
 * confirms the booking rather than releasing it. Anything else — not online,
 * already settled, money already on it — is handed back untouched.
 */
export async function releaseUnpaidOnlineBooking(booking: BookingDoc): Promise<BookingDoc> {
  if (booking.paymentMethod !== "RAZORPAY" || booking.status !== "PENDING") return booking;

  for (const orderId of booking.razorpayOrderIds ?? []) {
    const settled = await recoverPaidOrder(orderId);
    if (settled) return settled;
  }
  if ((booking.amountPaid ?? 0) > 0) return booking;

  try {
    return await rejectBooking(booking._id, "Customer changed slot before paying", { username: "customer" });
  } catch (err) {
    // The webhook confirmed it between our question and this write. What it is
    // now is the answer; the customer is shown that, not a conflict.
    const db = await getDb();
    const current = await collections.bookings(db).findOne({ _id: booking._id });
    if (current && current.status !== "PENDING") return current;
    throw err;
  }
}

/** Settle whatever was actually captured against an order we lost track of. */
async function recoverPaidOrder(orderId: string): Promise<BookingDoc | null> {
  const payments = await fetchOrderPayments(orderId);
  const captured = payments.find((p) => p.status === "captured");
  if (!captured) return null;
  log.warn("razorpay_payment_recovered", { orderId, paymentId: captured.id });
  return settleRazorpayPayment(settleableFrom(captured), "recovery");
}

/**
 * Give back the slots of bookings whose online payment never happened.
 *
 * Razorpay is asked before anything is released. The dangerous case is a customer
 * who is slow rather than absent — money taken at minute sixteen against a slot
 * released at minute fifteen — and a single question to the gateway ("has
 * anything been paid on this order?") turns that from a refund into a confirmed
 * booking. Only a booking with no payment at all, on any of its orders, is let go.
 */
export async function reclaimAbandonedOnlinePayments(
  scope: { resourceId?: ObjectId; date?: string } = {},
  now: Date = new Date(),
): Promise<number> {
  const db = await getDb();
  const cutoff = new Date(now.getTime() - ONLINE_PAYMENT_GRACE_MINUTES * 60_000);

  const stale = await collections
    .bookings(db)
    .find(
      {
        ...(scope.resourceId ? { resourceId: scope.resourceId } : {}),
        ...(scope.date ? { date: scope.date } : {}),
        status: "PENDING",
        paymentMethod: "RAZORPAY",
        amountPaid: 0,
        createdAt: { $lt: cutoff },
      },
      { projection: { _id: 1, reference: 1, razorpayOrderIds: 1 } },
    )
    // A ceiling so one sweep cannot turn into a long transaction storm on a day
    // when something has gone badly wrong. The next sweep picks up the rest.
    .limit(25)
    .toArray();

  if (stale.length === 0) return 0;

  let released = 0;
  for (const booking of stale) {
    try {
      let paid = false;
      for (const orderId of booking.razorpayOrderIds ?? []) {
        const recovered = await recoverPaidOrder(orderId);
        if (recovered) {
          paid = true;
          break;
        }
      }
      if (paid) continue;

      await rejectBooking(booking._id, "Online payment was not completed", { username: "system" });
      released += 1;
    } catch (err) {
      // One stuck booking must not stop the rest being reclaimed.
      log.warn("online_payment_reclaim_failed", { reference: booking.reference, err });
    }
  }

  if (released > 0) log.info("online_payments_reclaimed", { released, checked: stale.length });
  return released;
}
