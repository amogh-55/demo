import { z } from "zod";
import { ObjectId } from "mongodb";
import { isValidBusinessDate, MINUTES_IN_DAY } from "./time";

export const objectIdSchema = z
  .string()
  .refine((v) => ObjectId.isValid(v), "Invalid identifier")
  .transform((v) => new ObjectId(v));

export const businessDateSchema = z.string().refine(isValidBusinessDate, "Invalid date");

export const minuteOfDaySchema = z.number().int().min(0).max(MINUTES_IN_DAY);

/**
 * Indian mobile numbers. Accepts +91 / 91 / 0 prefixes and spaces, dashes or
 * brackets; stores the bare 10 digits. First digit must be 6-9.
 */
export const phoneSchema = z
  .string()
  .trim()
  .transform((raw) => raw.replace(/[\s()\-.]/g, ""))
  .transform((v) => v.replace(/^\+?91/, "").replace(/^0+/, ""))
  .refine((v) => /^[6-9]\d{9}$/.test(v), "Enter a valid 10-digit Indian mobile number");

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

export const bookingSubmitSchema = z.object({
  holdToken: z.string().min(32).max(128),
  customerName: customerNameSchema,
  customerPhone: phoneSchema,
  /**
   * Absent for a session small enough to pay for at the ground. Still checked for
   * shape when present, and the SERVER decides whether leaving it out is allowed —
   * omitting it never makes a booking free by itself.
   */
  paymentScreenshotKey: screenshotKeySchema.nullish().transform((v) => v ?? null),
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
  }),
  z.object({ action: z.literal("CONFIRM") }),
  /** The only destructive action: releases the slots. */
  z.object({ action: z.literal("REJECT"), reason: z.string().trim().min(3).max(300) }),
  z.object({ action: z.literal("WHATSAPP_OPENED"), kind: z.enum(["CONFIRM", "REJECT", "BALANCE"]) }),
]);

export const addPaymentSchema = z.object({
  paymentScreenshotKey: screenshotKeySchema,
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
export const facilityConfigSchema = z
  .object({
    slotMinutes: z.number().int().min(15).max(240),
    openMin: minuteOfDaySchema,
    closeMin: minuteOfDaySchema,
    priceRules: z.array(priceRuleSchema).min(1, "Add at least one price band"),
    bookingWindowDays: z.number().int().min(0).max(365),
    holdMinutes: z.number().int().min(2).max(60),
    /** OVERS only: how many overs one slot buys. 0 for hourly facilities. */
    oversPerSlot: z.number().int().min(0).max(100).default(0),
    /** OVERS only: the largest session that skips online payment. 0 = never skip. */
    payAtVenueMaxOvers: z.number().int().min(0).max(10_000).default(0),
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
  });

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
  /** Blank is allowed and means "use the support number". */
  notifyPhone: z.union([z.literal(""), phoneSchema]).default(""),
  notifyOnNewBooking: z.boolean().default(false),
});

export const adminBookingsQuerySchema = z.object({
  locationId: z.string().optional(),
  date: z.string().optional(),
  status: z.enum(["PENDING", "CONFIRMED", "REJECTED", "CANCELLED", "EXPIRED"]).optional(),
  payment: z.enum(["PENDING", "PARTIAL", "VERIFIED", "REJECTED"]).optional(),
  search: z.string().trim().max(60).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
});
