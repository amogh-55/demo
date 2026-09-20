/**
 * Every failure a customer or admin can see is one of these. Raw driver errors
 * and stack traces stay on the server; the client only ever gets `message`.
 */
export type AppErrorCode =
  | "VALIDATION"
  | "NOT_FOUND"
  | "SLOT_CONFLICT"
  | "HOLD_EXPIRED"
  | "HOLD_INVALID"
  | "DAY_BLOCKED"
  | "PAST_DATE"
  | "OUTSIDE_WINDOW"
  | "LOCATION_INACTIVE"
  | "UPLOAD_INVALID"
  | "UPLOAD_FAILED"
  | "RATE_LIMITED"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "CONFLICT"
  | "INTERNAL";

const STATUS: Record<AppErrorCode, number> = {
  VALIDATION: 400,
  NOT_FOUND: 404,
  SLOT_CONFLICT: 409,
  HOLD_EXPIRED: 410,
  HOLD_INVALID: 403,
  DAY_BLOCKED: 409,
  PAST_DATE: 400,
  OUTSIDE_WINDOW: 400,
  LOCATION_INACTIVE: 409,
  UPLOAD_INVALID: 400,
  UPLOAD_FAILED: 502,
  RATE_LIMITED: 429,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  CONFLICT: 409,
  INTERNAL: 500,
};

const DEFAULT_MESSAGE: Record<AppErrorCode, string> = {
  VALIDATION: "Please check the details you entered and try again.",
  NOT_FOUND: "We could not find what you were looking for.",
  SLOT_CONFLICT: "This slot was just taken by someone else. Please choose another time.",
  HOLD_EXPIRED: "Your slot hold has expired. Please select the slot again.",
  HOLD_INVALID: "We could not verify your slot hold. Please select the slot again.",
  DAY_BLOCKED: "This location is not taking bookings on the selected date.",
  PAST_DATE: "That time has already passed. Please pick an upcoming slot.",
  OUTSIDE_WINDOW: "Bookings are not open that far ahead yet.",
  LOCATION_INACTIVE: "This location is not accepting bookings right now.",
  UPLOAD_INVALID: "Please upload a JPG, PNG or WebP image under 5MB.",
  UPLOAD_FAILED: "Payment screenshot could not be uploaded. Please try again.",
  RATE_LIMITED: "Too many attempts. Please wait a moment and try again.",
  UNAUTHORIZED: "Please sign in to continue.",
  FORBIDDEN: "You do not have permission to do that.",
  CONFLICT: "That action conflicts with the current state. Please refresh and try again.",
  INTERNAL: "Something went wrong. Please try again.",
};

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: AppErrorCode, message?: string, details?: unknown) {
    super(message ?? DEFAULT_MESSAGE[code]);
    this.name = "AppError";
    this.code = code;
    this.status = STATUS[code];
    this.details = details;
  }
}

export const appError = (code: AppErrorCode, message?: string, details?: unknown) =>
  new AppError(code, message, details);
