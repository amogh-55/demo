import "server-only";
import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { AppError, appError } from "./errors";
import { log } from "./log";

export const HOLD_COOKIE = "turf_hold";
/**
 * The customer's most recently submitted booking reference.
 *
 * Kept separate from HOLD_COOKIE on purpose: the hold cookie is about the slot
 * being reserved right now, and reusing it to remember a finished booking meant a
 * customer could not start a second booking until it expired.
 */
export const LAST_BOOKING_COOKIE = "turf_booking";

export function ok<T>(data: T, init?: ResponseInit) {
  return NextResponse.json(data, { status: 200, ...init });
}

/**
 * The single place a thrown error becomes an HTTP response. Anything that is not
 * a deliberate AppError is logged in full and reduced to a generic message, so
 * driver errors and stack traces can never reach a browser.
 */
export function fail(err: unknown, context: Record<string, unknown> = {}) {
  if (err instanceof AppError) {
    return NextResponse.json(
      { error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } },
      { status: err.status },
    );
  }

  if (err instanceof ZodError) {
    const first = err.issues[0];
    const message = first?.message ?? "Please check the details you entered.";
    return NextResponse.json(
      { error: { code: "VALIDATION", message, field: first?.path?.join(".") } },
      { status: 400 },
    );
  }

  log.error("unhandled_api_error", { err, ...context });
  const generic = appError("INTERNAL");
  return NextResponse.json({ error: { code: generic.code, message: generic.message } }, { status: 500 });
}

export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw appError("VALIDATION", "Malformed request.");
  }
}
