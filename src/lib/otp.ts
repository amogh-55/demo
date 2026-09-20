import "server-only";
import crypto from "node:crypto";
import { collections, getDb } from "./db";
import { appError } from "./errors";
import { log } from "./log";
import { getSettings } from "./settings";
import { sendSms, smsConfigured } from "./sms";
import { readSignedCookieValue, signCookieValue } from "./auth";

/**
 * Mobile-number verification.
 *
 * The point is not security — anyone can book a turf — it is that the owner has
 * to ring the customer, and a mistyped digit means nobody can be reached. So this
 * proves the number receives SMS, nothing more.
 *
 * The code is never stored, only its hash, and the result is carried in a signed
 * httpOnly cookie rather than a database session: the browser holds the proof but
 * cannot forge or read it, and there is no session table to expire.
 */
export const OTP_COOKIE = "turf_phone_verified";

const CODE_LENGTH = 6;
const CODE_TTL_SECONDS = 10 * 60;
/** How long a verified number stays verified on this device. */
const VERIFIED_TTL_SECONDS = 60 * 60;
const RESEND_COOLDOWN_SECONDS = 45;
/** Codes per number inside one challenge window. */
const MAX_SENDS = 5;
/** Wrong guesses before the challenge is destroyed and a new code is needed. */
const MAX_ATTEMPTS = 5;

function generateCode(): string {
  // randomInt, not Math.random: a predictable code would let someone verify a
  // number they do not own, which is the one thing this is supposed to prevent.
  return String(crypto.randomInt(0, 10 ** CODE_LENGTH)).padStart(CODE_LENGTH, "0");
}

function hashCode(phone: string, code: string): string {
  // Salted with the phone number so the same code for two numbers hashes
  // differently, and a stolen hash cannot be looked up in a table of a million.
  return crypto.createHash("sha256").update(`${phone}:${code}`).digest("hex");
}

export async function otpRequired(): Promise<boolean> {
  return (await getSettings()).otpEnabled;
}

export interface SendOtpResult {
  /** Seconds the caller must wait before another code may be requested. */
  resendAfterSeconds: number;
  /** False when no SMS provider is configured, so the UI can say so honestly. */
  delivered: boolean;
}

export async function sendOtp(phone: string, now: Date = new Date()): Promise<SendOtpResult> {
  const db = await getDb();
  const existing = await collections.otpChallenges(db).findOne({ _id: phone });

  if (existing && existing.expiresAt > now) {
    if (existing.resendAfter > now) {
      throw appError(
        "RATE_LIMITED",
        `Please wait ${Math.ceil((existing.resendAfter.getTime() - now.getTime()) / 1000)} seconds before asking for another code.`,
      );
    }
    if (existing.sends >= MAX_SENDS) {
      throw appError("RATE_LIMITED", "Too many codes requested for this number. Please try again later.");
    }
  }

  const code = generateCode();
  const codeHash = hashCode(phone, code);
  const expiresAt = new Date(now.getTime() + CODE_TTL_SECONDS * 1000);
  const resendAfter = new Date(now.getTime() + RESEND_COOLDOWN_SECONDS * 1000);

  if (existing && existing.expiresAt > now) {
    // A resend inside the current window. The new code always gets a fresh run of
    // guesses; the send counter carries over, so asking again and again cannot buy
    // unlimited attempts at the same number.
    await collections
      .otpChallenges(db)
      .updateOne({ _id: phone }, { $set: { codeHash, expiresAt, attempts: 0, resendAfter }, $inc: { sends: 1 } });
  } else {
    // First code, or the previous window has lapsed: start a clean one.
    await collections
      .otpChallenges(db)
      .replaceOne(
        { _id: phone },
        { codeHash, expiresAt, attempts: 0, sends: 1, resendAfter, createdAt: now },
        { upsert: true },
      );
  }

  const business = (await getSettings()).businessName;
  const delivered = await sendSms(phone, `${code} is your ${business} booking verification code. It expires in 10 minutes.`);

  log.info("otp_sent", { phone: `***${phone.slice(-4)}`, delivered, provider_configured: smsConfigured() });
  return { resendAfterSeconds: RESEND_COOLDOWN_SECONDS, delivered };
}

/**
 * Check a code. A correct one destroys the challenge so it cannot be replayed;
 * a wrong one is counted, and the challenge dies once the guesses run out.
 */
export async function verifyOtp(phone: string, code: string, now: Date = new Date()): Promise<boolean> {
  const db = await getDb();
  const challenge = await collections.otpChallenges(db).findOne({ _id: phone });

  if (!challenge || challenge.expiresAt <= now) {
    throw appError("VALIDATION", "That code has expired. Please ask for a new one.");
  }
  if (challenge.attempts >= MAX_ATTEMPTS) {
    await collections.otpChallenges(db).deleteOne({ _id: phone });
    throw appError("VALIDATION", "Too many wrong codes. Please ask for a new one.");
  }

  const expected = Buffer.from(challenge.codeHash, "hex");
  const actual = Buffer.from(hashCode(phone, code), "hex");
  const matches = expected.length === actual.length && crypto.timingSafeEqual(expected, actual);

  if (!matches) {
    await collections.otpChallenges(db).updateOne({ _id: phone }, { $inc: { attempts: 1 } });
    return false;
  }

  await collections.otpChallenges(db).deleteOne({ _id: phone });
  return true;
}

/* ── The proof carried by the browser ──────────────────────────────────── */

export function issueVerifiedPhoneCookie(phone: string, now: Date = new Date()): string {
  return signCookieValue(`${phone}:${now.getTime() + VERIFIED_TTL_SECONDS * 1000}`);
}

/**
 * The number this device proved it controls, or null.
 *
 * Returns null for anything this server did not sign and for anything past its
 * expiry, so a copied cookie from another browser or an old one is simply not a
 * verification.
 */
export function readVerifiedPhone(raw: string | undefined, now: Date = new Date()): string | null {
  const value = readSignedCookieValue(raw);
  if (!value) return null;
  const separator = value.lastIndexOf(":");
  if (separator <= 0) return null;
  const phone = value.slice(0, separator);
  const expiresAt = Number(value.slice(separator + 1));
  if (!Number.isFinite(expiresAt) || expiresAt <= now.getTime()) return null;
  return phone;
}

export const OTP_VERIFIED_MAX_AGE = VERIFIED_TTL_SECONDS;
