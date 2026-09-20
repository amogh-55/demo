import type { ObjectId } from "mongodb";

/** State of one atomic bookable unit. Absent document == AVAILABLE. */
export type SlotStatus = "AVAILABLE" | "HELD" | "PENDING" | "BOOKED" | "BLOCKED";

/** What the public availability API reports per unit. PAST is derived, never stored. */
export type PublicSlotStatus = SlotStatus | "PAST";

export type BookingStatus = "PENDING" | "CONFIRMED" | "REJECTED" | "CANCELLED" | "EXPIRED";
/**
 * PARTIAL is the case that matters in practice: the customer paid something, but
 * less than the booking costs. The slots stay reserved while the balance is
 * chased — only an explicit rejection releases them.
 */
export type PaymentStatus = "PENDING" | "PARTIAL" | "VERIFIED" | "REJECTED";

/** One screenshot the customer sent. A booking may collect several. */
export interface PaymentAttempt {
  id: string;
  /** Null when an admin recorded the payment themselves, with no screenshot sent. */
  screenshotKey: string | null;
  uploadedAt: Date;
  /**
   * What the admin read off the screenshot, in rupees. Null until reviewed —
   * the customer never states an amount, so nothing here is client-controlled.
   */
  amount: number | null;
  status: "PENDING" | "ACCEPTED" | "REJECTED";
  reviewedBy: string | null;
  reviewedAt: Date | null;
  note: string | null;
  /**
   * Set when the retention job removed the image. The attempt itself — amount,
   * verdict, who approved it — is kept forever; only the file is gone, and this
   * is what tells the admin screen the difference between "deleted after 7 days"
   * and "no screenshot was ever sent".
   */
  screenshotExpiredAt?: Date | null;
}

export interface LocationDoc {
  _id: ObjectId;
  name: string;
  slug: string;
  address: string;
  description: string;
  image: string;
  phone: string;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface PriceRule {
  /** [fromMin, toMin) in IST minutes-of-day. */
  fromMin: number;
  toMin: number;
  price: number;
}

export interface SlotConfigDoc {
  _id: ObjectId;
  locationId: ObjectId;
  /** Length of one atomic unit, minutes. */
  slotMinutes: number;
  /** Operating window, IST minutes-of-day, half-open [openMin, closeMin). */
  openMin: number;
  closeMin: number;
  priceRules: PriceRule[];
  /** How many days ahead customers may book (0 = today only). */
  bookingWindowDays: number;
  /** Temporary hold lifetime, minutes. */
  holdMinutes: number;
  updatedAt: Date;
}

export interface SlotUnitDoc {
  _id: ObjectId;
  locationId: ObjectId;
  /** Business date, IST, "YYYY-MM-DD". */
  date: string;
  /** Half-open interval [startMin, endMin) in IST minutes-of-day. */
  startMin: number;
  endMin: number;
  status: SlotStatus;
  /** SHA-256 of the hold token. The raw token never touches the database. */
  holdTokenHash: string | null;
  holdUntil: Date | null;
  bookingId: ObjectId | null;
  /** Unit price captured when the unit was taken. */
  price: number;
  blockReason: string | null;
  blockedBy: string | null;
  blockedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface DayBlockDoc {
  _id: ObjectId;
  locationId: ObjectId;
  date: string;
  reason: string;
  blockedBy: string;
  blockedAt: Date;
}

export interface BookingTimelineEntry {
  event: string;
  at: Date;
  by: string;
  note?: string;
}

export interface BookingDoc {
  _id: ObjectId;
  reference: string;
  locationId: ObjectId;
  /** Snapshot: a location rename must not rewrite history. */
  locationName: string;
  date: string;
  startMin: number;
  endMin: number;
  /** Start minute of every atomic unit this booking owns. */
  unitStarts: number[];
  /** Price snapshot — never recomputed after creation. */
  amount: number;
  priceBreakdown: Array<{ startMin: number; endMin: number; price: number }>;
  customerName: string;
  /** Normalised to 10 digits, no country code. */
  customerPhone: string;
  status: BookingStatus;
  paymentVerificationStatus: PaymentStatus;
  /** Every screenshot sent for this booking, oldest first. Never overwritten. */
  payments: PaymentAttempt[];
  /** Sum of the accepted attempts. Derived server-side, never sent by a browser. */
  amountPaid: number;
  /** The most recent screenshot, kept for quick access. */
  paymentScreenshotKey: string | null;
  paymentUploadedAt: Date | null;
  rejectionReason: string | null;
  holdTokenHash: string;
  timeline: BookingTimelineEntry[];
  createdAt: Date;
  updatedAt: Date;
}

export interface AdminUserDoc {
  _id: ObjectId;
  username: string;
  /** scrypt: "scrypt$<saltHex>$<keyHex>" — never plaintext, never reversible. */
  passwordHash: string;
  displayName: string;
  active: boolean;
  createdAt: Date;
  lastLoginAt: Date | null;
}

export interface AuditLogDoc {
  _id: ObjectId;
  adminId: string;
  adminUsername: string;
  action: string;
  entityType: string;
  entityId: string;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

export interface SettingsDoc {
  _id: string;
  businessName: string;
  supportPhone: string;
  whatsappNumber: string;
  upiId: string;
  upiPayeeName: string;
  upiQrImageUrl: string;
  updatedAt: Date;
}

export interface RateLimitDoc {
  _id: string;
  count: number;
  expiresAt: Date;
}
