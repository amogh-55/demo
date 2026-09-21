import "server-only";
import crypto from "node:crypto";
import { readSignedCookieValue, signCookieValue } from "@/lib/auth";

/**
 * Evidence that a payment screenshot could not be stored.
 *
 * The booking flow lets a customer finish on their UTR alone when the storage
 * provider is down, because losing a paid booking to our own outage is worse
 * than losing the image. That exemption is worth abusing: a client that simply
 * posts no screenshot key looks exactly like one whose upload failed.
 *
 * So the claim never comes from the client. The upload route signs this token
 * after — and only after — a genuine store failure, and hands it back as an
 * httpOnly cookie. It names the hold the failure happened on, so it cannot be
 * kept and replayed against the next booking, and it expires on its own.
 *
 * A file the customer chose badly (too large, wrong type, empty, corrupt) is a
 * validation error and never mints one of these. That is the whole distinction:
 * our fault exempts, their fault does not.
 */

/** Comfortably longer than a 5-minute hold, short enough not to be hoarded. */
const TTL_SECONDS = 30 * 60;

/** The hold identity, hashed: the raw token never needs to be in a second cookie. */
function holdFingerprint(holdToken: string): string {
  return crypto.createHash("sha256").update(`upload-failure:${holdToken}`).digest("hex").slice(0, 32);
}

export function issueUploadFailureToken(holdToken: string, now: Date = new Date()): string {
  return signCookieValue(`${holdFingerprint(holdToken)}:${now.getTime() + TTL_SECONDS * 1000}`);
}

/**
 * Whether this browser genuinely failed to upload for the hold it is now booking.
 *
 * Returns false for anything this server did not sign, anything past its expiry,
 * and anything issued for a different hold.
 */
export function uploadFailureProven(raw: string | undefined, holdToken: string, now: Date = new Date()): boolean {
  const value = readSignedCookieValue(raw);
  if (!value) return false;

  const separator = value.lastIndexOf(":");
  if (separator <= 0) return false;

  const fingerprint = value.slice(0, separator);
  const expiresAt = Number(value.slice(separator + 1));
  if (!Number.isFinite(expiresAt) || expiresAt <= now.getTime()) return false;

  // Compared in constant time out of habit rather than need: both sides are
  // public hashes, but this is the check that gates the exemption.
  const actual = Buffer.from(fingerprint, "utf8");
  const expected = Buffer.from(holdFingerprint(holdToken), "utf8");
  if (actual.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export const UPLOAD_FAILURE_MAX_AGE = TTL_SECONDS;
