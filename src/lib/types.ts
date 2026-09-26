import type { ObjectId } from "mongodb";

/** State of one atomic bookable unit. Absent document == AVAILABLE. */
export type SlotStatus = "AVAILABLE" | "HELD" | "PENDING" | "BOOKED" | "BLOCKED";

/** What the public availability API reports per unit. PAST is derived, never stored. */
export type PublicSlotStatus = SlotStatus | "PAST";

export type BookingStatus = "PENDING" | "CONFIRMED" | "REJECTED" | "CANCELLED" | "EXPIRED";

/**
 * The five piles the owner sorts bookings into on the admin screen.
 *
 * Lives here rather than beside the query that uses it because the tab strip is a
 * client component, and the query module is server-only — importing it into the
 * browser bundle would fail the build.
 *
 * "verify" is the one that is not a status: it means "somebody sent money and is
 * waiting on me", which is the actual job of that screen.
 */
export type BookingTab = "all" | "pending" | "verify" | "confirmed" | "completed" | "rejected";

export const BOOKING_TABS: ReadonlyArray<{ id: BookingTab; label: string }> = [
  { id: "all", label: "All" },
  { id: "pending", label: "Pending" },
  { id: "verify", label: "To verify" },
  { id: "confirmed", label: "Confirmed" },
  { id: "completed", label: "Completed" },
  { id: "rejected", label: "Rejected" },
];
/**
 * PARTIAL is the case that matters in practice: the customer paid something, but
 * less than the booking costs. The slots stay reserved while the balance is
 * chased — only an explicit rejection releases them.
 */
export type PaymentStatus = "PENDING" | "PARTIAL" | "VERIFIED" | "REJECTED";

/**
 * How a facility is sold.
 *
 *  HOURLY — the customer picks a time range off the grid and pays per slot.
 *           Box cricket, nets, pickleball courts.
 *  OVERS  — the customer picks a number of overs and a ball type. The overs map
 *           to a duration, the duration to consecutive 15-minute units, and the
 *           ball type carries the price. Bowling machines.
 *
 * Both sell the SAME atomic units underneath, so the concurrency guarantees are
 * identical; only the way a customer expresses what they want differs.
 */
export type FacilityKind = "HOURLY" | "OVERS";

/** One screenshot the customer sent. A booking may collect several. */
/**
 * What became of the screenshot behind a payment.
 *
 * UPLOADED — the image is in the store and can be opened.
 * FAILED   — the customer chose a valid image, the storage provider could not
 *            take it, and the booking went through on the UTR alone. The owner
 *            must check this one against the bank statement by hand.
 * NONE     — there was never an image to upload: an admin recorded this payment,
 *            or the session is paid for at the ground.
 */
export type ScreenshotUploadStatus = "UPLOADED" | "FAILED" | "NONE";

/**
 * Why an upload did not happen. Only ever set alongside FAILED, and only ever
 * for an infrastructure fault — a file the customer chose badly is refused
 * outright and never reaches a booking at all.
 */
export type ScreenshotFailureReason = "STORAGE_UNAVAILABLE";

/**
 * Where the money in a payment attempt came from.
 *
 * MANUAL   — a UPI transfer the customer made themselves and an admin verified,
 *            or cash the admin recorded. Someone looked at it and decided.
 * RAZORPAY — taken through the payment gateway and settled server-side against
 *            Razorpay's own record of it. No human verified anything, and none
 *            needs to.
 *
 * Absent on every attempt written before the gateway existed, which are all
 * manual — so a missing value reads as MANUAL everywhere.
 */
export type PaymentProvider = "MANUAL" | "RAZORPAY";

/** How a booking is being paid for online. Absent for pay-at-venue and staff bookings. */
export type BookingPaymentMethod = "UPI_MANUAL" | "RAZORPAY";

export interface PaymentAttempt {
  id: string;
  /** Null when an admin recorded the payment themselves, or when the upload failed. */
  screenshotKey: string | null;
  /**
   * Which of the three happened. Kept explicitly rather than inferred from
   * `screenshotKey === null`, because "the provider was down" and "there was
   * never a screenshot" are the same absence and completely different problems.
   */
  uploadStatus: ScreenshotUploadStatus;
  /** Set only with FAILED. */
  uploadFailureReason: ScreenshotFailureReason | null;
  /**
   * The 12-digit UPI reference the customer typed, which is what the owner
   * actually matches against the bank statement.
   *
   * This — not the screenshot — is what proves a payment, so it is asked for on
   * every online payment and an image that never arrives costs nobody a booking.
   * Null on a payment an admin recorded by hand, where there is no UPI reference
   * to give.
   */
  utr: string | null;
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
  /** Absent means MANUAL — every attempt written before the gateway existed. */
  provider?: PaymentProvider;
  /**
   * Razorpay's own identifiers for this payment.
   *
   * `razorpayPaymentId` is what makes settling a payment happen exactly once: the
   * browser's success callback and the webhook describe the same payment, arrive
   * in either order, and whichever is second finds this id already on the booking
   * and does nothing. It is the idempotency key, not merely a reference.
   */
  razorpayOrderId?: string | null;
  razorpayPaymentId?: string | null;
  /** upi, card, netbanking, wallet — what the customer actually paid with. */
  razorpayMethod?: string | null;
}

export interface LocationDoc {
  _id: ObjectId;
  name: string;
  slug: string;
  address: string;
  /** Google Maps link shown to customers. Empty until the owner supplies one. */
  mapsUrl: string;
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

/**
 * A ball type and what one slot of it costs.
 *
 * One slot is {@link FacilityConfig.oversPerSlot} overs — ten, at present — so
 * this is the owner's "₹180 for 10 overs" verbatim. A longer session is that
 * price per block: 20 overs is two slots and twice the money, 50 overs is five.
 * Nothing is pro-rated by the clock, because the owner does not sell by the clock.
 */
export interface BallType {
  id: string;
  name: string;
  pricePerSlot: number;
}

/**
 * Hours, pricing and booking rules for one facility.
 *
 * Lives on the facility rather than the location because a location can sell
 * several different things: Medipally's nets and its bowling machine keep
 * separate hours, separate prices and separate availability. Pickleball's two
 * courts share one facility and therefore one set of hours, edited once.
 */
export interface FacilityConfig {
  /** Length of one atomic unit, minutes. 60 for hourly play, 15 for bowling. */
  slotMinutes: number;
  /** Operating window, IST minutes-of-day, half-open [openMin, closeMin). */
  openMin: number;
  closeMin: number;
  /**
   * HOURLY: what each slot costs, by time of day.
   * OVERS: a single rule spanning the operating window at price 0 — the ball
   * type carries the real price. Maintained server-side so it cannot drift.
   */
  priceRules: PriceRule[];
  /**
   * The same bands again for the days that cost more, or empty for a ground that
   * charges the same all week.
   *
   * Kept as a separate table rather than a multiplier or a flag on each band,
   * because that is how the owner thinks about it and how the board at the gate
   * reads: two columns, weekday and weekend, each with its own hours and prices.
   * Empty means every day uses {@link priceRules}, which is what every existing
   * facility has.
   */
  weekendPriceRules?: PriceRule[];
  /**
   * Which days the weekend table applies to. 0 Sunday … 6 Saturday.
   *
   * Configurable because "the weekend" is a local fact, not a calendar one: the
   * grounds around here charge more from Friday evening, and a ground that fills
   * up on Wednesdays should be able to say so.
   */
  weekendDays?: number[];
  /** How many days ahead customers may book (0 = today only). */
  bookingWindowDays: number;
  /** Temporary hold lifetime, minutes. */
  holdMinutes: number;
  /**
   * OVERS only: how many overs one slot buys. Ten overs to a 15-minute slot.
   *
   * This single number is the whole overs rule. Duration is (overs / this) slots,
   * and so is the price, which is why there is no separate ladder to keep in step
   * with the clock and no ceiling written into the code: a customer may ask for
   * 70 overs and get seven slots at seven times the block price.
   */
  oversPerSlot: number;
  /**
   * OVERS only: the largest session that may be booked WITHOUT paying online.
   *
   * At or below this the customer is confirmed on the spot and pays at the ground,
   * because chasing a screenshot for a short net session costs the owner more
   * goodwill than it protects. Above it, an online payment is required first.
   * Zero means every session must pay online.
   */
  payAtVenueMaxOvers: number;
  /**
   * What share of the total a customer may pay online to hold the booking,
   * settling the rest at the ground. 0 means the full amount is due up front,
   * which is what every facility did before this existed.
   *
   * A percentage rather than a fixed figure because the owner thinks in halves:
   * "half now, half at the ground" holds whether the pitch is ₹700 or ₹1,200.
   * The rupee amount is always computed server-side from the booking's own total,
   * so a client cannot decide what it owes.
   */
  advancePercent?: number;
  /** OVERS only. Empty for HOURLY facilities. */
  ballTypes: BallType[];
}

export interface FacilityDoc {
  _id: ObjectId;
  locationId: ObjectId;
  name: string;
  slug: string;
  kind: FacilityKind;
  description: string;
  sortOrder: number;
  active: boolean;
  config: FacilityConfig;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * One independently bookable thing: a turf, a net, a machine, a court.
 *
 * This — not the location and not the facility — is what slot units are keyed
 * on. Pickleball Court 1 and Court 2 are two resources, so 6–7 PM on one has
 * nothing to do with 6–7 PM on the other, and neither can be double booked,
 * without a single line of court-specific logic.
 */
export interface ResourceDoc {
  _id: ObjectId;
  locationId: ObjectId;
  facilityId: ObjectId;
  name: string;
  slug: string;
  sortOrder: number;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface SlotUnitDoc {
  _id: ObjectId;
  /** The bookable thing. Unique with (date, startMin) — the double-booking guard. */
  resourceId: ObjectId;
  /** Denormalised so admin screens can filter without joining. */
  locationId: ObjectId;
  facilityId: ObjectId;
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
  /** OVERS facilities: which ball the hold was priced for. Null elsewhere. */
  ballTypeId: string | null;
  /**
   * OVERS facilities: the overs the customer actually asked for.
   *
   * Recorded rather than re-derived from the duration, because the two disagree
   * if the owner changes overs-per-slot mid-booking, and the customer must get
   * what they were quoted.
   */
  overs: number | null;
  blockReason: string | null;
  blockedBy: string | null;
  blockedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface DayBlockDoc {
  _id: ObjectId;
  /** Blocks are per resource: closing one court leaves the other open. */
  resourceId: ObjectId;
  locationId: ObjectId;
  facilityId: ObjectId;
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
  resourceId: ObjectId;
  facilityId: ObjectId;
  locationId: ObjectId;
  /** Snapshots: a rename must not rewrite history. */
  locationName: string;
  facilityName: string;
  resourceName: string;
  date: string;
  startMin: number;
  endMin: number;
  /** Start minute of every atomic unit this booking owns. */
  unitStarts: number[];
  /** OVERS bookings only: what the customer actually bought. */
  overs: number | null;
  ballTypeName: string | null;
  /**
   * Confirmed on the spot, with the money to be collected at the ground.
   *
   * Short bowling sessions skip the online payment entirely, so such a booking is
   * CONFIRMED while its payment is still PENDING — a combination that is normally
   * impossible. This flag is what tells the admin screen the difference between
   * "they owe us and are coming" and "something went wrong".
   */
  payAtVenue: boolean;
  /** Price snapshot — never recomputed after creation. */
  amount: number;
  priceBreakdown: Array<{ startMin: number; endMin: number; price: number }>;
  customerName: string;
  /** Normalised to 10 digits, no country code. */
  customerPhone: string;
  /** True when an OTP was verified for this number at booking time. */
  phoneVerified: boolean;
  /**
   * The staff member who took this booking over the phone, or null when the
   * customer made it themselves.
   *
   * A booking somebody rang in for has no screenshot, no UTR and often no money
   * yet, all of which read as problems on a booking that came off the website.
   * This is what tells the two apart on the admin screen.
   */
  createdBy: string | null;
  status: BookingStatus;
  paymentVerificationStatus: PaymentStatus;
  /** Every screenshot sent for this booking, oldest first. Never overwritten. */
  payments: PaymentAttempt[];
  /** Sum of the accepted attempts. Derived server-side, never sent by a browser. */
  amountPaid: number;
  /**
   * What this customer was asked to pay online, which is `amount` unless they
   * took the advance option. Recorded so the owner can tell an agreed half
   * payment from someone who simply paid too little — both leave the booking
   * PARTIAL, and only this says which one happened.
   */
  amountDueNow?: number;
  /**
   * How this booking is paying online. Absent on a pay-at-venue session, on one
   * staff took over the phone, and on every booking made before the gateway
   * existed — all of which are manual by definition.
   *
   * RAZORPAY is what excuses a booking from arriving with a UTR and a screenshot:
   * it is created before the money moves and settled when the gateway says the
   * money moved. Set by the server from its own configuration, never from the
   * request body, so a client cannot claim it to skip the evidence.
   */
  paymentMethod?: BookingPaymentMethod;
  /**
   * Every Razorpay order raised for this booking, oldest first.
   *
   * An array rather than one id because a customer who abandons checkout and
   * tries again may be given a fresh order, and a webhook for the abandoned one
   * can still arrive afterwards — it must still find its booking. This is the
   * index the webhook looks the booking up by.
   */
  razorpayOrderIds?: string[];
  /**
   * When the confirmation emails went out. Set once, by whichever request got
   * there first, so a retried webhook cannot email the customer twice.
   */
  confirmationEmailAt?: Date | null;
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

export interface SettingsDoc {
  _id: string;
  businessName: string;
  supportPhone: string;
  whatsappNumber: string;
  upiId: string;
  upiPayeeName: string;
  /**
   * Mobile-number verification for customers, switchable without a deploy.
   *
   * Off means the booking flow never asks for a code and no SMS is ever sent,
   * which is what keeps the bill at zero until the owner has an SMS account.
   */
  otpEnabled: boolean;
  /**
   * Offer card/UPI/netbanking payment through Razorpay at booking time.
   *
   * A switch rather than a deploy, for the same reason OTP is one: the gateway
   * account is the owner's, and if it is suspended or the keys are rotated they
   * need to fall back to the UPI-screenshot flow in the time it takes to save a
   * form. Has no effect unless the Razorpay keys are present in the environment.
   */
  razorpayEnabled: boolean;
  /**
   * Offer the pay-by-UPI-and-send-a-screenshot route alongside the gateway.
   *
   * Turning it off leaves online payment as the only way to book, which is what
   * the owner wants once the gateway is trusted: no screenshots to squint at.
   *
   * It is deliberately NOT honoured when the gateway is unavailable — no keys, or
   * the switch above turned off. A site that offers no way to pay at all is worse
   * than one showing an option the owner would rather retire, so this yields.
   */
  upiScreenshotEnabled: boolean;
  /**
   * Email the owner a copy of every booking that confirms.
   *
   * On by default and free to run, unlike the SMS switches below — but it is the
   * owner's own inbox, and a busy ground can confirm a lot of bookings a day.
   * Has no effect unless Resend and OWNER_EMAIL are configured.
   */
  emailOnBooking: boolean;
  /**
   * Whether the owner's copy also goes out for a booking they took over the
   * phone themselves. Separate because they already know about those, and the
   * email service's free allowance is better spent on the ones they do not.
   */
  emailOnPhoneBooking: boolean;
  updatedAt: Date;
}

/**
 * One outstanding mobile-verification challenge, keyed by phone number.
 *
 * The code itself is never stored — only its hash — so a database dump cannot be
 * replayed into somebody's booking. Documents delete themselves via the TTL index
 * on `expiresAt`.
 */
export interface OtpChallengeDoc {
  _id: string;
  codeHash: string;
  expiresAt: Date;
  /** Wrong guesses so far. The challenge dies after a handful. */
  attempts: number;
  /** Codes sent for this number inside the current window, for resend limits. */
  sends: number;
  /** Earliest moment another code may be sent. */
  resendAfter: Date;
  createdAt: Date;
}

export interface RateLimitDoc {
  _id: string;
  count: number;
  expiresAt: Date;
}
