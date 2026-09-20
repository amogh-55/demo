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

export const holdRequestSchema = z.object({
  locationId: objectIdSchema,
  date: businessDateSchema,
  startMin: minuteOfDaySchema,
  endMin: minuteOfDaySchema,
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
  paymentScreenshotKey: screenshotKeySchema,
});

export const availabilityQuerySchema = z.object({
  locationId: objectIdSchema,
  date: businessDateSchema,
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

export const blockSlotsSchema = z.object({
  locationId: objectIdSchema,
  date: businessDateSchema,
  startMin: minuteOfDaySchema,
  endMin: minuteOfDaySchema,
  reason: z.string().trim().min(3).max(200),
  /** Set only after the admin has seen and accepted the conflict warning. */
  force: z.boolean().optional().default(false),
});

export const unblockSlotsSchema = z.object({
  locationId: objectIdSchema,
  date: businessDateSchema,
  startMin: minuteOfDaySchema,
  endMin: minuteOfDaySchema,
});

export const blockDaySchema = z.object({
  locationId: objectIdSchema,
  date: businessDateSchema,
  reason: z.string().trim().min(3).max(200),
  force: z.boolean().optional().default(false),
});

export const unblockDaySchema = z.object({
  locationId: objectIdSchema,
  date: businessDateSchema,
});

export const locationCreateSchema = z.object({
  name: z.string().trim().min(2).max(80),
  slug: z
    .string()
    .trim()
    .min(2)
    .max(60)
    .regex(/^[a-z0-9-]+$/, "Use lowercase letters, numbers and hyphens only"),
  address: z.string().trim().min(5).max(300),
  description: z.string().trim().max(500).default(""),
  image: z.string().trim().max(300).default(""),
  phone: phoneSchema,
  active: z.boolean().default(true),
});

export const locationUpdateSchema = locationCreateSchema.partial().omit({ slug: true });

const priceRuleSchema = z
  .object({
    fromMin: minuteOfDaySchema,
    toMin: minuteOfDaySchema,
    price: z.number().int().min(0).max(1_000_000),
  })
  .refine((r) => r.toMin > r.fromMin, "Price rule must end after it starts");

export const slotConfigSchema = z
  .object({
    slotMinutes: z.number().int().min(15).max(240),
    openMin: minuteOfDaySchema,
    closeMin: minuteOfDaySchema,
    priceRules: z.array(priceRuleSchema).min(1, "Add at least one price rule"),
    bookingWindowDays: z.number().int().min(0).max(365),
    holdMinutes: z.number().int().min(2).max(60),
  })
  .refine((c) => c.closeMin > c.openMin, { message: "Closing time must be after opening time", path: ["closeMin"] })
  .refine((c) => (c.closeMin - c.openMin) % c.slotMinutes === 0, {
    message: "Operating hours must divide evenly into slots",
    path: ["slotMinutes"],
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
  upiQrImageUrl: z.string().trim().max(500).default(""),
});

export const adminBookingsQuerySchema = z.object({
  locationId: z.string().optional(),
  date: z.string().optional(),
  status: z.enum(["PENDING", "CONFIRMED", "REJECTED", "CANCELLED", "EXPIRED"]).optional(),
  payment: z.enum(["PENDING", "PARTIAL", "VERIFIED", "REJECTED"]).optional(),
  search: z.string().trim().max(60).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
});
