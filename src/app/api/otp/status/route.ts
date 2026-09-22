import { cookies } from "next/headers";
import { fail, ok } from "@/lib/api";
import { OTP_COOKIE, readVerifiedPhone } from "@/lib/otp";

export const dynamic = "force-dynamic";

/**
 * What number, if any, this browser has proved it controls.
 *
 * The cookie is httpOnly and signed, so the page cannot read it and cannot forge
 * one — which is exactly why this exists. It is the only way to see the state the
 * booking route will actually act on, rather than the client's own memory of
 * having verified something.
 */
export async function GET() {
  try {
    const phone = readVerifiedPhone((await cookies()).get(OTP_COOKIE)?.value);
    return ok({ verified: Boolean(phone), phone });
  } catch (err) {
    return fail(err, { route: "GET /api/otp/status" });
  }
}
