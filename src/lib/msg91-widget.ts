import "server-only";
import { appError } from "./errors";
import { log } from "./log";

/**
 * MSG91's OTP Widget.
 *
 * MSG91 sends the code, counts the wrong guesses and expires it. We never
 * generate, store or see a one-time code, which is the point of using the widget
 * at all — the old {@link ./otp} path did all three and is still what runs when
 * the widget is not configured.
 *
 * What the browser ends up holding is an access token. On its own it proves
 * nothing: it arrives in a request body, and anything in a request body was
 * typed by whoever sent it. This module is the half that gives it meaning. The
 * token goes back to MSG91 over the server's own AuthKey, and only MSG91's answer
 * decides whether a number is verified.
 *
 * Nothing here is reachable from the browser. The AuthKey is read from the server
 * environment and never leaves this file.
 */

const VERIFY_URL = "https://control.msg91.com/api/v5/widget/verifyAccessToken";
/** A slow provider must never hold a customer's verification open. */
const TIMEOUT_MS = 8000;

export interface WidgetConfig {
  widgetId: string;
  tokenAuth: string;
}

/**
 * The two values the widget needs in the browser.
 *
 * These are identifiers rather than secrets — the widget cannot run without them
 * and everything in a page is readable — but they are deliberately not
 * NEXT_PUBLIC_*. Read here and passed to the one component that needs them, they
 * reach only the pages that actually verify a number, and changing them is a
 * restart rather than a rebuild. The AuthKey is the secret, and it is not in this
 * object.
 */
export function widgetConfig(): WidgetConfig | null {
  const widgetId = (process.env.MSG91_WIDGET_ID || "").trim();
  const tokenAuth = (process.env.MSG91_WIDGET_TOKEN || "").trim();
  return widgetId && tokenAuth ? { widgetId, tokenAuth } : null;
}

/** Whether the server can check a token. Without this the widget is decoration. */
export function widgetVerifyConfigured(): boolean {
  return Boolean((process.env.MSG91_AUTH_KEY || "").trim());
}

/** The last ten digits, which is how every number in this application is stored. */
function localDigits(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const digits = String(value).replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : null;
}

/**
 * The number MSG91 says this token belongs to.
 *
 * Two places are tried because MSG91 does not publish the response body and what
 * it returns has changed: the documented field is `message`, which in current
 * accounts carries the verified number, and older ones put only the word
 * "success" there with the number in the token's own payload.
 *
 * Reading that payload is safe here and only here. The token is a JWT whose
 * signature we never check — but this runs after MSG91 accepted *this exact
 * token* under our AuthKey, and MSG91 accepts only tokens it issued. A forged
 * token never reaches this line, so what is inside it is MSG91's word, not the
 * caller's.
 *
 * Exported for the tests: the shapes below are the whole security argument.
 */
export function phoneFromVerification(body: unknown, accessToken: string): string | null {
  const message = (body as { message?: unknown } | null)?.message;
  const fromBody = localDigits(message);
  if (fromBody) return fromBody;

  const payload = decodeTokenPayload(accessToken);
  if (!payload) return null;
  for (const key of ["mobile", "identifier", "number", "phone", "mobile_number"]) {
    const found = localDigits(payload[key]);
    if (found) return found;
  }
  return null;
}

/** The middle segment of a JWT, or null for anything that is not one. */
function decodeTokenPayload(token: string): Record<string, unknown> | null {
  const segments = token.split(".");
  if (segments.length !== 3) return null;
  try {
    const json = Buffer.from(segments[1]!, "base64url").toString("utf8");
    const parsed: unknown = JSON.parse(json);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Ask MSG91 whose handset this token belongs to.
 *
 * Returns the verified ten-digit number. Everything else throws, because there is
 * no useful middle state: a token MSG91 will not vouch for is not a verification,
 * and neither is one it vouches for without saying whose number it is. Failing
 * closed on that second case matters — without a number to compare, "verified"
 * would mean only that the caller verified *some* handset, and a customer could
 * put their own code against somebody else's booking.
 */
export async function verifyAccessToken(accessToken: string): Promise<string> {
  const authkey = (process.env.MSG91_AUTH_KEY || "").trim();
  if (!authkey) {
    log.error("msg91_widget_authkey_missing");
    throw appError("INTERNAL", "Mobile verification is not configured. Please contact us to book.");
  }

  let response: Response;
  try {
    response = await fetch(VERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // MSG91 names it with a hyphen. The token is not logged anywhere.
      body: JSON.stringify({ authkey, "access-token": accessToken }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (err) {
    // A timeout or a DNS failure is ours, not the customer's. Say so plainly
    // rather than telling them their correct code was wrong.
    log.error("msg91_widget_verify_unreachable", { err: err instanceof Error ? err.name : "unknown" });
    throw appError("UPLOAD_FAILED", "We could not reach the verification service. Please try again in a moment.");
  }

  const body: unknown = await response.json().catch(() => null);
  const type = String((body as { type?: unknown } | null)?.type ?? "").toLowerCase();

  if (!response.ok || type !== "success") {
    // The message is MSG91's and may name the token; only the status and the
    // type are recorded, never the body.
    log.warn("msg91_widget_verify_rejected", { status: response.status, type: type || "none" });
    throw appError("VALIDATION", "That verification could not be confirmed. Please request a new code.");
  }

  const phone = phoneFromVerification(body, accessToken);
  if (!phone) {
    log.error("msg91_widget_verify_no_number", { status: response.status });
    throw appError("INTERNAL", "We could not confirm which number was verified. Please try again.");
  }

  log.info("msg91_widget_verified", { phone: `***${phone.slice(-4)}` });
  return phone;
}
