import crypto from "node:crypto";

/**
 * Human-readable booking reference, e.g. TURF-7K92AB.
 * Alphabet excludes 0/O/1/I/L so it survives being read out over the phone.
 * Random, not sequential, so references leak nothing about booking volume.
 */
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

export function generateBookingReference(): string {
  const bytes = crypto.randomBytes(6);
  let out = "";
  for (let i = 0; i < 6; i += 1) out += ALPHABET[bytes[i]! % ALPHABET.length];
  return `TURF-${out}`;
}

/** 256 bits of entropy: possession of the raw token IS proof of hold ownership. */
export function generateHoldToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

export function hashHoldToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}
