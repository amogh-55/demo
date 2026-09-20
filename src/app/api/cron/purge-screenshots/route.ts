import crypto from "node:crypto";
import { fail, ok } from "@/lib/api";
import { purgeExpiredScreenshots } from "@/lib/booking/service";
import { appError } from "@/lib/errors";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";

/**
 * Daily retention job: deletes payment screenshots for bookings played more than
 * a week ago. Scheduled in vercel.json; Vercel sends CRON_SECRET as a bearer
 * token on every cron invocation.
 *
 * The route is a plain HTTPS endpoint, so it is only as private as that secret.
 * With CRON_SECRET unset it refuses outright rather than running unauthenticated —
 * an open endpoint that deletes files is not something to leave lying around.
 */
export async function GET(request: Request) {
  try {
    const secret = process.env.CRON_SECRET;
    if (!secret) {
      log.error("cron_secret_missing", { route: "purge-screenshots" });
      throw appError("NOT_FOUND");
    }

    const offered = Buffer.from(request.headers.get("authorization") ?? "", "utf8");
    const expected = Buffer.from(`Bearer ${secret}`, "utf8");
    // Compare lengths first: timingSafeEqual throws on a size mismatch.
    if (offered.length !== expected.length || !crypto.timingSafeEqual(offered, expected)) {
      throw appError("NOT_FOUND");
    }

    const result = await purgeExpiredScreenshots();
    return ok(result);
  } catch (err) {
    return fail(err, { route: "GET /api/cron/purge-screenshots" });
  }
}
