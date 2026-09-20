import "server-only";
import { collections, getDb, isDuplicateKeyError } from "./db";
import { appError } from "./errors";
import { log } from "./log";

/**
 * Counter-in-Mongo rate limiting. Chosen over an in-process Map because serverless
 * instances do not share memory, which would make an in-memory limiter useless
 * exactly where brute-force protection matters (admin login).
 * Documents self-destruct via the TTL index on `expiresAt`.
 */
export async function rateLimit(key: string, limit: number, windowSeconds: number): Promise<void> {
  const db = await getDb();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + windowSeconds * 1000);

  const bump = () =>
    collections.rateLimits(db).findOneAndUpdate(
      { _id: key, expiresAt: { $gt: now } },
      { $inc: { count: 1 }, $setOnInsert: { expiresAt } },
      { upsert: true, returnDocument: "after" },
    );

  let doc: Awaited<ReturnType<typeof bump>>;
  try {
    doc = await bump();
  } catch (err) {
    // The TTL monitor only sweeps once a minute, so an expired counter can still
    // be present: the filter misses it, the upsert tries to insert, and the _id
    // collides. Clear the stale window and start a fresh one.
    if (!isDuplicateKeyError(err)) throw err;
    await collections.rateLimits(db).deleteOne({ _id: key, expiresAt: { $lte: now } });
    doc = await bump();
  }

  if (doc && doc.count > limit) {
    log.warn("rate_limit_exceeded", { key, count: doc.count, limit });
    throw appError("RATE_LIMITED");
  }
}

/** Clear a counter after a legitimate success (e.g. correct admin password). */
export async function resetRateLimit(key: string): Promise<void> {
  const db = await getDb();
  await collections.rateLimits(db).deleteOne({ _id: key });
}

/**
 * Best-effort client identity. Behind Vercel/Cloudflare the first XFF hop is the client.
 *
 * Note for tuning the limits that use this: Indian mobile networks put very many
 * subscribers behind one public address (CGNAT), so an IP is closer to "a carrier"
 * than "a person". The customer-facing limits are set generously for that reason;
 * only the admin login, where the account name gives a second and far narrower
 * bucket, is kept tight.
 */
export function clientIp(headers: Headers): string {
  const xff = headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  return headers.get("x-real-ip") ?? "unknown";
}
