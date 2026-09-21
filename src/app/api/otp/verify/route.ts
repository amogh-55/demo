import { cookies } from "next/headers";
import { fail, ok, readJson } from "@/lib/api";
import { appError } from "@/lib/errors";
import { issueVerifiedPhoneCookie, OTP_COOKIE, OTP_VERIFIED_MAX_AGE, otpRequired, verifyOtp } from "@/lib/otp";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import { otpVerifySchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

/**
 * Check a code and, if it is right, remember that this browser owns the number.
 *
 * The proof is an httpOnly cookie signed by this server. A client cannot mint one,
 * cannot read it, and cannot move it to another number — which is why the booking
 * route trusts the cookie and never trusts a "verified" flag in a request body.
 */
export async function POST(request: Request) {
  try {
    await rateLimit(`otp-verify-ip:${clientIp(request.headers)}`, 40, 3600, { shared: true });

    if (!(await otpRequired())) {
      throw appError("VALIDATION", "Mobile verification is not switched on.");
    }

    const { phone, code } = otpVerifySchema.parse(await readJson(request));
    const matched = await verifyOtp(phone, code);
    if (!matched) throw appError("VALIDATION", "That code is not correct. Please check and try again.");

    (await cookies()).set(OTP_COOKIE, issueVerifiedPhoneCookie(phone), {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: OTP_VERIFIED_MAX_AGE,
    });

    return ok({ verified: true });
  } catch (err) {
    return fail(err, { route: "POST /api/otp/verify" });
  }
}
