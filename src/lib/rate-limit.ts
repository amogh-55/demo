import "server-only";
import { collections, getDb, isDuplicateKeyError } from "./db";
import { appError } from "./errors";
import { log } from "./log";

/**
 * Rate limiting in two layers.
 *
 * The counter lives in memory by default and in MongoDB only where it has to.
 * That split exists because the shared counter was measured serialising the
 * whole site: every public request wrote to one document per IP, and thirty
 * customers arriving together — which on an Indian mobile network can mean one
 * public address — turned a 40ms page into a 2.7-second one, purely from write
 * contention on that single row.
 *
 * The memory counter is per instance, so on a serverless deployment the true
 * ceiling is the limit multiplied by however many instances are warm. For the
 * public limits that is fine: they exist to stop a script hammering the site,
 * not to meter anything, and the numbers are already generous.
 *
 * Where the count must hold across instances — a password being guessed, an SMS
 * that costs the owner money every time it is sent — {@link shared} keeps the
 * database counter. Those endpoints are rare and slow by nature, so the write
 * contention that ruined the public ones never arises. Even there the memory
 * counter runs first, so a client hammering the login page is turned away
 * without the database hearing about it at all.
 */

interface Window {
  count: number;
  /** Epoch ms at which this window is finished and starts again. */
  resetAt: number;
}

const windows = new Map<string, Window>();
/** Bounded so a flood of distinct keys cannot grow this without limit. */
const MAX_KEYS = 20_000;

function bumpLocal(key: string, windowSeconds: number, now: number): number {
  const existing = windows.get(key);
  if (!existing || existing.resetAt <= now) {
    if (windows.size >= MAX_KEYS) sweep(now);
    const fresh = { count: 1, resetAt: now + windowSeconds * 1000 };
    windows.set(key, fresh);
    return 1;
  }
  existing.count += 1;
  return existing.count;
}

/** Drop finished windows; if that frees nothing, drop the oldest half. */
function sweep(now: number): void {
  for (const [key, window] of windows) {
    if (window.resetAt <= now) windows.delete(key);
  }
  if (windows.size < MAX_KEYS) return;
  const ordered = [...windows.entries()].sort((a, b) => a[1].resetAt - b[1].resetAt);
  for (const [key] of ordered.slice(0, Math.floor(ordered.length / 2))) windows.delete(key);
}

export interface RateLimitOptions {
  /**
   * Count in the database as well, so the limit holds across every instance.
   *
   * For anything where exceeding the limit costs money or weakens security: an
   * SMS, a password guess. Not for ordinary page traffic.
   */
  shared?: boolean;
}

export async function rateLimit(
  key: string,
  limit: number,
  windowSeconds: number,
  options: RateLimitOptions = {},
): Promise<void> {
  const nowMs = Date.now();

  // Always first, and free. A caller already over the limit on this instance is
  // refused without a database round trip, which is the whole point.
  if (bumpLocal(key, windowSeconds, nowMs) > limit) {
    log.warn("rate_limit_exceeded", { key, limit, scope: "instance" });
    throw appError("RATE_LIMITED");
  }

  if (!options.shared) return;

  const db = await getDb();
  const now = new Date(nowMs);
  const expiresAt = new Date(nowMs + windowSeconds * 1000);

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
    log.warn("rate_limit_exceeded", { key, count: doc.count, limit, scope: "shared" });
    throw appError("RATE_LIMITED");
  }
}

/** Clear a counter after a legitimate success (e.g. correct admin password). */
export async function resetRateLimit(key: string): Promise<void> {
  windows.delete(key);
  const db = await getDb();
  await collections.rateLimits(db).deleteOne({ _id: key });
}

/** Testing only: forget every in-memory window. */
export function clearLocalRateLimits(): void {
  windows.clear();
}

/**
 * Best-effort client identity, from headers the client cannot choose.
 *
 * `x-forwarded-for` is appended to by every hop, so its first entry is whatever
 * the caller put there — which meant a scraper could defeat every IP limit on
 * the site by sending a different random value with each request. The headers
 * the platform sets itself are checked first for that reason; Vercel overwrites
 * its own `x-vercel-*` headers on the way in, so they cannot be forged, and
 * `x-real-ip` is set by both Vercel and Cloudflare.
 *
 * The forwarded-for fallback is kept last for a plain reverse proxy that sets
 * nothing else, and for local development, where there is no proxy at all and
 * the header is simply absent.
 *
 * Note for tuning the limits that use this: Indian mobile networks put very many
 * subscribers behind one public address (CGNAT), so an IP is closer to "a carrier"
 * than "a person". The customer-facing limits are set generously for that reason;
 * only the admin login, where the account name gives a second and far narrower
 * bucket, is kept tight.
 */
export function clientIp(headers: Headers): string {
  const trusted = headers.get("x-vercel-forwarded-for") ?? headers.get("cf-connecting-ip") ?? headers.get("x-real-ip");
  if (trusted) return trusted.split(",")[0]!.trim();
  const xff = headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  return "unknown";
}
