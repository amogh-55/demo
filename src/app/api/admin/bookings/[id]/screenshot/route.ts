import { ObjectId } from "mongodb";
import { NextResponse } from "next/server";
import { fail } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { collections, getDb } from "@/lib/db";
import { appError } from "@/lib/errors";
import { getScreenshotAccess } from "@/lib/storage";

export const dynamic = "force-dynamic";

const PRIVATE = { "Cache-Control": "no-store, private" };

/**
 * Payment screenshots are never publicly reachable. This route is the only way to
 * see one: it checks the admin session first, then either redirects to a URL that
 * dies in five minutes (S3) or streams the bytes back (local development disk).
 * The stored object key is never exposed to any browser.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const admin = await requireAdmin();
    const raw = (await params).id;
    if (!ObjectId.isValid(raw)) throw appError("NOT_FOUND");

    const db = await getDb();
    const booking = await collections.bookings(db).findOne({ _id: new ObjectId(raw) });
    if (!booking) throw appError("NOT_FOUND", "That booking no longer exists.");

    /**
     * A booking can carry several screenshots — the first payment, then the
     * balance. The admin reviews ONE attempt at a time and must see that
     * attempt's own image: showing the newest one while they type an amount
     * against an older one is how the wrong figure gets recorded.
     */
    const attemptId = new URL(request.url).searchParams.get("attempt");
    const attempt = attemptId ? (booking.payments ?? []).find((p) => p.id === attemptId) : undefined;
    if (attemptId && !attempt) throw appError("NOT_FOUND", "That payment screenshot is not available.");

    if (attempt && !attempt.screenshotKey) {
      throw appError(
        "NOT_FOUND",
        attempt.screenshotExpiredAt
          ? "This screenshot was deleted a week after the match. The payment record is still here."
          : "That payment was recorded by staff, so there is no screenshot.",
      );
    }
    const key = attempt?.screenshotKey ?? booking.paymentScreenshotKey;
    if (!key) throw appError("NOT_FOUND", "No payment screenshot was uploaded.");

    const access = await getScreenshotAccess(key, 300);

    if (access.kind === "redirect") {
      return NextResponse.redirect(access.url, { status: 302, headers: PRIVATE });
    }

    return new NextResponse(Buffer.from(access.body), {
      status: 200,
      headers: {
        ...PRIVATE,
        "Content-Type": access.contentType,
        "Content-Disposition": "inline",
        // The bytes are attacker-supplied, so never let a browser sniff them into
        // something executable.
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; img-src 'self'; sandbox",
      },
    });
  } catch (err) {
    return fail(err, { route: "GET /api/admin/bookings/[id]/screenshot" });
  }
}
