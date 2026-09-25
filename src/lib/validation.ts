import { z } from "zod";
import { ObjectId } from "mongodb";
import { isValidBusinessDate, MINUTES_IN_DAY } from "./time";
import type { PriceRule } from "./types";

export const objectIdSchema = z
  .string()
  .refine((v) => ObjectId.isValid(v), "Invalid identifier")
  .transform((v) => new ObjectId(v));

export const businessDateSchema = z.string().refine(isValidBusinessDate, "Invalid date");

export const minuteOfDaySchema = z.number().int().min(0).max(MINUTES_IN_DAY);

/**
 * Indian mobile numbers. Accepts +91 / 91 / 0 prefixes and spaces, dashes or
 * brackets; stores the bare 10 digits. First digit must be 6-9.
 *
 * A prefix is only stripped when what is left is still a whole number. Stripping
 * "91" on sight is wrong: 9121563584 is a real mobile that begins 91, and taking
 * two digits off it left eight and a customer who could not book at all.
 */
export const phoneSchema = z
  .string()
  .trim()
  .transform((raw) => raw.replace(/[\s()\-.]/g, ""))
  .transform((v) => {
    const digits = v.replace(/^\+/, "").replace(/^00/, "");
    if (/^91\d{10}$/.test(digits)) return digits.slice(2);
    if (/^0\d{10}$/.test(digits)) return digits.slice(1);
    return digits;
  })
  .refine((v) => /^[6-9]\d{9}$/.test(v), "Enter a valid 10-digit Indian mobile number");

/**
 * A customer's email address, which exists only so a confirmation can be sent to
 * it. Optional everywhere — an empty string means "they did not give one" rather
 * than a validation failure, because a blank optional field is what an untouched
 * input actually submits.
 */
export const optionalEmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(120, "That email address is too long")
  .refine((v) => v === "" || /^[^\s@]+@[^\s@.]+\.[^\s@]{2,}$/.test(v), "Enter a valid email address, or leave it blank")
  .transform((v) => (v === "" ? null : v));

export const customerNameSchema = z
  .string()
  .trim()
  .min(2, "Please enter your full name")
  .max(60, "Name is too long")
  .regex(/^[\p{L}][\p{L}\s.'-]*$/u, "Name contains unsupported characters");

/**
 * A hold request speaks whichever language the facility uses: an hourly range,
 * or a start time plus overs and a ball. Which one is required is decided by the
 * facility's own kind on the server, so a request that brings the wrong pair is
 * refused there rather than quietly booking something else.
 */
export const holdRequestSchema = z.object({
  resourceId: objectIdSchema,
  date: businessDateSchema,
  startMin: minuteOfDaySchema,
  endMin: minuteOfDaySchema.optional(),
  /**
   * No upper bound worth speaking of: how many overs may be booked is decided by
   * how much of the day is still free, not by a number kept in step here. This
   * only keeps an absurd value out of the arithmetic.
   */
  overs: z.number().int().min(1).max(10_000).optional(),
  ballTypeId: z.string().trim().min(1).max(40).optional(),
});

/**
 * Storage keys are minted by the upload route, never composed by a browser.
 * Checking the shape here stops a client submitting a booking that points at a
 * screenshot which does not exist — the admin would have nothing to verify.
 */
export const SCREENSHOT_KEY_PATTERN =
  /^payment-screenshots\/\d{4}-\d{2}-\d{2}\/[0-9a-f-]{36}\.(jpg|png|webp)$/;

export const screenshotKeySchema = z
  .string()
  .regex(SCREENSHOT_KEY_PATTERN, "That payment screenshot is no longer available. Please upload it again.");

/**
 * The UPI reference number off the payment app — 12 digits, and the thing the
 * owner searches for in the bank statement.
 *
 * Spaces are stripped because people copy it out of a notification with them,
 * and the digits are checked here so a typo is caught while the customer is
 * still on the payment screen rather than at the ground.
 */
export const utrSchema = z
  .string()
  .trim()
  .transform((raw) => raw.replace(/[\s-]/g, ""))
  .refine((v) => /^\d{12}$/.test(v), "Enter the 12-digit UPI reference number (UTR) from your payment app");

export const bookingSubmitSchema = z.object({
  holdToken: z.string().min(32).max(128),
  customerName: customerNameSchema,
  customerPhone: phoneSchema,
  /**
   * Absent when the upload did not go through, and absent for a session small
   * enough to pay for at the ground. Still checked for shape when present.
   *
   * A booking is no longer refused for want of an image: the UTR below is what
   * the owner reconciles against, and a customer who has genuinely paid should
   * not lose their slot because a photo would not upload on ground wifi.
   */
  paymentScreenshotKey: screenshotKeySchema.nullish().transform((v) => v ?? null),
  /**
   * Required for anything paid online — the SERVER decides which those are, from
   * the hold, so omitting it never makes a booking free.
   */
  utr: utrSchema.nullish().transform((v) => v ?? null),
  /**
   * The customer pressed "pay the advance" rather than "pay in full". A choice,
   * not an amount — the rupee figure is computed server-side from the facility's
   * configuration, so this cannot be used to decide what is owed.
   */
  payAdvance: z.boolean().optional(),
  /**
   * Which payment method the customer chose. A preference, not permission: the
   * server checks its own Razorpay configuration and the owner's own switch, and
   * refuses outright if online payment is asked for while it is not available —
   * it never silently downgrades to the manual flow, which would leave the
   * customer staring at a demand for a UTR they were never asked to produce.
   */
  paymentMethod: z.enum(["UPI_MANUAL", "RAZORPAY"]).optional(),
  /** Optional. Only ever used to email a confirmation. */
  customerEmail: optionalEmailSchema.nullish().transform((v) => v ?? null),
});

/**
 * What Razorpay Checkout hands back on success.
 *
 * All three are checked against Razorpay itself before a rupee is recorded, so
 * the only job here is to refuse a body that could not possibly have come from
 * the gateway.
 */
export const razorpayVerifySchema = z.object({
  razorpay_order_id: z.string().trim().min(6).max(60),
  razorpay_payment_id: z.string().trim().min(6).max(60),
  razorpay_signature: z
    .string()
    .trim()
    .regex(/^[0-9a-f]{64}$/i, "Invalid payment signature"),
});

/**
 * A booking the owner takes over the phone.
 *
 * It says WHAT to book in exactly the language the facility speaks — an hourly
 * range, or a start plus overs and a ball — and never what it costs: the amount
 * is computed from the stored schedule, the same as for a customer booking.
 */
export const adminBookingCreateSchema = z.object({
  resourceId: objectIdSchema,
  date: businessDateSchema,
  startMin: minuteOfDaySchema,
  endMin: minuteOfDaySchema.optional(),
  overs: z.number().int().min(1).max(10_000).optional(),
  ballTypeId: z.string().trim().min(1).max(40).optional(),
  customerName: customerNameSchema,
  customerPhone: phoneSchema,
  /** Money taken there and then. Zero (the default) means collect at the ground. */
  amountPaid: z.number().int().min(0).max(1_000_000).default(0),
  note: z.string().trim().max(300).default(""),
});

export const availabilityQuerySchema = z.object({
  resourceId: objectIdSchema,
  date: businessDateSchema,
});

export const otpSendSchema = z.object({ phone: phoneSchema });

export const otpVerifySchema = z.object({
  phone: phoneSchema,
  code: z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code we sent you"),
});

/**
 * What the browser sends back after MSG91's widget has verified a number. The
 * token is checked with MSG91 before it counts for anything, so the only job
 * here is to refuse a body that could not possibly be one.
 */
export const otpWidgetVerifySchema = z.object({
  phone: phoneSchema,
  accessToken: z.string().trim().min(16).max(4096),
});

export const adminLoginSchema = z.object({
  username: z.string().trim().min(3).max(60),
  password: z.string().min(8).max(200),
});

export const bookingActionSchema = z.discriminatedUnion("action", [
  /** Accept one screenshot for the amount the ADMIN read on it. Slots untouched. */
  z.object({
    action: z.literal("ACCEPT_PAYMENT"),
    attemptId: z.string().uuid(),
    amount: z.number().int().min(1).max(1_000_000),
    note: z.string().trim().max(300).optional(),
  }),
  /** Turn down one screenshot. The booking stays pending and keeps its slots. */
  z.object({
    action: z.literal("REJECT_PAYMENT"),
    attemptId: z.string().uuid(),
    note: z.string().trim().min(3).max(300),
  }),
  /**
   * Money the admin confirmed themselves — paid on WhatsApp, in cash, or from a
   * different phone. No screenshot exists, so a note explaining it is required.
   */
  z.object({
    action: z.literal("RECORD_PAYMENT"),
    amount: z.number().int().min(1).max(1_000_000),
    note: z.string().trim().min(3, "Say where this payment came from").max(300),
    /** Optional: cash has no reference, a UPI transfer read off the statement does. */
    utr: utrSchema.nullish().transform((v) => v ?? null),
  }),
  z.object({ action: z.literal("CONFIRM") }),
  /** The only destructive action: releases the slots. */
  z.object({ action: z.literal("REJECT"), reason: z.string().trim().min(3).max(300) }),
  z.object({ action: z.literal("WHATSAPP_OPENED"), kind: z.enum(["CONFIRM", "REJECT", "BALANCE"]) }),
]);

/** A balance payment is evidenced the same way a first payment is: UTR always, image if it uploads. */
export const addPaymentSchema = z.object({
  paymentScreenshotKey: screenshotKeySchema.nullish().transform((v) => v ?? null),
  utr: utrSchema,
});

/**
 * What a block covers. Exactly one of the three, and the server expands it into
 * the resources it means: one court, every court in a facility, or the whole
 * ground shut for a festival.
 */
const blockTargetSchema = z
  .object({
    resourceId: objectIdSchema.optional(),
    facilityId: objectIdSchema.optional(),
    locationId: objectIdSchema.optional(),
  })
  .refine(
    (t) => [t.resourceId, t.facilityId, t.locationId].filter(Boolean).length === 1,
    "Choose exactly one thing to block",
  );

export const blockSlotsSchema = blockTargetSchema.and(
  z.object({
    date: businessDateSchema,
    startMin: minuteOfDaySchema,
    endMin: minuteOfDaySchema,
    reason: z.string().trim().min(3).max(200),
    /** Set only after the admin has seen and accepted the conflict warning. */
    force: z.boolean().optional().default(false),
  }),
);

export const unblockSlotsSchema = blockTargetSchema.and(
  z.object({
    date: businessDateSchema,
    startMin: minuteOfDaySchema,
    endMin: minuteOfDaySchema,
  }),
);

export const blockDaySchema = blockTargetSchema.and(
  z.object({
    date: businessDateSchema,
    reason: z.string().trim().min(3).max(200),
    force: z.boolean().optional().default(false),
  }),
);

export const unblockDaySchema = blockTargetSchema.and(z.object({ date: businessDateSchema }));

/**
 * Only http(s). A "maps link" beginning javascript: would run in the browser of
 * every customer who tapped Directions, so the scheme is checked here rather
 * than trusted to the anchor tag.
 */
const httpUrlSchema = z
  .string()
  .trim()
  .max(500)
  .refine((v) => v === "" || /^https?:\/\/\S+$/i.test(v), "Enter a link starting with https://");

export const locationCreateSchema = z.object({
  name: z.string().trim().min(2).max(80),
  slug: z
    .string()
    .trim()
    .min(2)
    .max(60)
    .regex(/^[a-z0-9-]+$/, "Use lowercase letters, numbers and hyphens only"),
  address: z.string().trim().min(5).max(300),
  mapsUrl: httpUrlSchema.default(""),
  description: z.string().trim().max(500).default(""),
  image: z.string().trim().max(300).default(""),
  phone: phoneSchema,
  active: z.boolean().default(true),
});

export const locationUpdateSchema = locationCreateSchema.partial().omit({ slug: true });

const slugSchema = z
  .string()
  .trim()
  .min(2)
  .max(60)
  .regex(/^[a-z0-9-]+$/, "Use lowercase letters, numbers and hyphens only");

export const facilityCreateSchema = z.object({
  locationId: objectIdSchema,
  name: z.string().trim().min(2).max(80),
  slug: slugSchema,
  kind: z.enum(["HOURLY", "OVERS"]),
  description: z.string().trim().max(300).default(""),
  sortOrder: z.number().int().min(0).max(999).default(0),
  active: z.boolean().default(true),
});

export const facilityUpdateSchema = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  description: z.string().trim().max(300).optional(),
  sortOrder: z.number().int().min(0).max(999).optional(),
  active: z.boolean().optional(),
});

export const resourceCreateSchema = z.object({
  facilityId: objectIdSchema,
  name: z.string().trim().min(1).max(80),
  slug: slugSchema,
  sortOrder: z.number().int().min(0).max(999).default(0),
  active: z.boolean().default(true),
});

export const resourceUpdateSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  sortOrder: z.number().int().min(0).max(999).optional(),
  active: z.boolean().optional(),
});

const priceRuleSchema = z
  .object({
    fromMin: minuteOfDaySchema,
    toMin: minuteOfDaySchema,
    price: z.number().int().min(0).max(1_000_000),
  })
  .refine((r) => r.toMin > r.fromMin, "Price rule must end after it starts");

const ballTypeSchema = z.object({
  id: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .regex(/^[a-z0-9-]+$/, "Use lowercase letters, numbers and hyphens only"),
  name: z.string().trim().min(2).max(60),
  /** What one block of overs costs with this ball — the owner's "₹180 for 10 overs". */
  pricePerSlot: z.number().int().min(0).max(1_000_000),
});

/**
 * A facility's whole schedule.
 *
 * The cross-field rules are what stop an edit producing a schedule the booking
 * engine cannot honour: hours that do not divide into whole slots would leave an
 * unsellable stub at the end of the day, and an overs option that is not a whole
 * number of slots could never be reserved atomically.
 */
/** Whether every slot the operating window produces falls inside some price band. */
function coversEveryStart(rules: PriceRule[], openMin: number, closeMin: number, slotMinutes: number): boolean {
  if (!(slotMinutes > 0) || !(closeMin > openMin)) return true; // Other refinements report these.
  for (let start = openMin; start + slotMinutes <= closeMin; start += slotMinutes) {
    if (!rules.some((r) => start >= r.fromMin && start < r.toMin)) return false;
  }
  return true;
}

export const facilityConfigSchema = z
  .object({
    slotMinutes: z.number().int().min(15).max(240),
    openMin: minuteOfDaySchema,
    closeMin: minuteOfDaySchema,
    priceRules: z.array(priceRuleSchema).min(1, "Add at least one price band"),
    /**
     * The weekend table. Empty is the normal case and means one price all week,
     * so a ground that never charged differently is untouched by any of this.
     */
    weekendPriceRules: z.array(priceRuleSchema).default([]),
    /** 0 Sunday … 6 Saturday. Around here the weekend starts on Friday. */
    weekendDays: z
      .array(z.number().int().min(0).max(6))
      .max(7)
      .default([5, 6, 0])
      .refine((days) => new Set(days).size === days.length, "Each day can only be listed once"),
    bookingWindowDays: z.number().int().min(0).max(365),
    holdMinutes: z.number().int().min(2).max(60),
    /** OVERS only: how many overs one slot buys. 0 for hourly facilities. */
    oversPerSlot: z.number().int().min(0).max(100).default(0),
    /** OVERS only: the largest session that skips online payment. 0 = never skip. */
    payAtVenueMaxOvers: z.number().int().min(0).max(10_000).default(0),
    /**
     * Share of the total a customer may pay online to hold the booking, settling
     * the rest at the ground. 0 means the whole amount is due up front. Capped
     * below 100 because "an advance of everything" is just paying in full.
     */
    advancePercent: z.number().int().min(0).max(99).default(0),
    ballTypes: z.array(ballTypeSchema).default([]),
  })
  .refine((c) => c.closeMin > c.openMin, { message: "Closing time must be after opening time", path: ["closeMin"] })
  .refine((c) => (c.closeMin - c.openMin) % c.slotMinutes === 0, {
    message: "Operating hours must divide evenly into slots",
    path: ["slotMinutes"],
  })
  .refine((c) => c.payAtVenueMaxOvers === 0 || c.oversPerSlot === 0 || c.payAtVenueMaxOvers % c.oversPerSlot === 0, {
    message: "The pay-at-the-ground limit must be a whole number of over blocks",
    path: ["payAtVenueMaxOvers"],
  })
  .refine((c) => new Set(c.ballTypes.map((b) => b.id)).size === c.ballTypes.length, {
    message: "Each ball type needs its own id",
    path: ["ballTypes"],
  })
  /**
   * Weekend prices that cover fewer hours than the weekday ones would make part
   * of a Saturday unsellable — the slot simply vanishes from the grid, which
   * reads as a bug rather than as a pricing decision.
   */
  .refine(
    (c) =>
      c.weekendPriceRules.length === 0 ||
      c.priceRules.every((weekday) =>
        c.weekendPriceRules.some((weekend) => weekend.fromMin <= weekday.fromMin && weekend.toMin >= weekday.toMin),
      ),
    {
      message: "Weekend bands must cover the same hours as the weekday ones, or a weekend slot would be unsellable",
      path: ["weekendPriceRules"],
    },
  )
  .refine((c) => c.weekendPriceRules.length === 0 || c.weekendDays.length > 0, {
    message: "Choose which days the weekend prices apply to",
    path: ["weekendDays"],
  })
  /**
   * Every sellable slot must carry a price.
   *
   * Unpriced time does not fail anywhere downstream — `buildDayTemplate` simply
   * skips it — so a ground that opens at midnight with bands starting at 6 AM
   * shows customers nothing before 6 and reports no error at all. The owner reads
   * that as the site being broken, which is fair, so it is refused at the door.
   */
  .refine((c) => coversEveryStart(c.priceRules, c.openMin, c.closeMin, c.slotMinutes), {
    message: "Some opening hours have no price band, so customers could not book them",
    path: ["priceRules"],
  })
  .refine(
    (c) =>
      c.weekendPriceRules.length === 0 ||
      coversEveryStart(c.weekendPriceRules, c.openMin, c.closeMin, c.slotMinutes),
    {
      message: "Some opening hours have no weekend price band, so customers could not book them",
      path: ["weekendPriceRules"],
    },
  );

export const settingsSchema = z.object({
  businessName: z.string().trim().min(2).max(80),
  supportPhone: phoneSchema,
  whatsappNumber: phoneSchema,
  upiId: z
    .string()
    .trim()
    .regex(/^[\w.\-]{2,60}@[a-zA-Z]{2,30}$/, "Enter a valid UPI ID, e.g. name@bank"),
  upiPayeeName: z.string().trim().min(2).max(80),
  /**
   * Checked like the maps link rather than taken as free text: this value is put
   * straight into an <img src> on the payment screen, so a "javascript:" or
   * "data:" URL saved here would be served to every customer paying.
   */
  upiQrImageUrl: httpUrlSchema.default(""),
  otpEnabled: z.boolean().default(false),
  /** Has no effect without Razorpay keys in the environment; the form says so. */
  razorpayEnabled: z.boolean().default(false),
  /** Ignored while the gateway is unavailable — see SettingsDoc. */
  upiScreenshotEnabled: z.boolean().default(true),
  /** Has no effect without Resend keys and OWNER_EMAIL; the form says so. */
  emailOnBooking: z.boolean().default(true),
  emailOnPhoneBooking: z.boolean().default(true),
});

export const adminBookingsQuerySchema = z.object({
  locationId: z.string().optional(),
  date: z.string().optional(),
  /** Which pile of bookings to show. See BOOKING_TABS — "verify" is the review queue. */
  tab: z.enum(["all", "pending", "verify", "confirmed", "rejected"]).optional(),
  status: z.enum(["PENDING", "CONFIRMED", "REJECTED", "CANCELLED", "EXPIRED"]).optional(),
  payment: z.enum(["PENDING", "PARTIAL", "VERIFIED", "REJECTED"]).optional(),
  search: z.string().trim().max(60).optional(),
  /** A facility name — "Box Cricket", "Nets" — matched across every ground that has one. */
  sport: z.string().trim().max(60).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
});
