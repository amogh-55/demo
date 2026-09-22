import { cookies } from "next/headers";
import { fail, ok, readJson } from "@/lib/api";
import { appError } from "@/lib/errors";
import { verifyAccessToken } from "@/lib/msg91-widget";
import { issueVerifiedPhoneCookie, OTP_COOKIE, OTP_VERIFIED_MAX_AGE } from "@/lib/otp";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import { otpWidgetVerifySchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

/**
 * Turn an MSG91 access token into this application's proof of a mobile number.
 *
 * The browser has already been through MSG91's widget, so the code itself was
 * never ours to check. What arrives here is a token, and a token in a request
 * body is a claim like any other — so it is spent against MSG91 over our own
 * AuthKey before anything is believed, and the number MSG91 names must be the
 * number the caller says they verified. Opening the widget, receiving a code, or
 * posting a plausible-looking string gets nobody past this line.
 *
 * On success the proof is the same signed httpOnly cookie the existing OTP path
 * issues, which is what {@link ../../bookings/route} already trusts — so nothing
 * downstream has to learn about MSG91 at all.
 */
export async function POST(request: Request) {
  try {
    // Each call costs an outbound request to MSG91 and nothing else, so this is
    // set to catch a script rather than a person retyping a code.
    await rateLimit(`otp-widget-verify-ip:${clientIp(request.headers)}`, 40, 3600, { shared: true });

    const { phone, accessToken } = otpWidgetVerifySchema.parse(await readJson(request));
    // Also per number: a stolen or replayed token is worth trying only so often.
    await rateLimit(`otp-widget-verify:${phone}`, 20, 3600, { shared: true });

    const verifiedPhone = await verifyAccessToken(accessToken);

    /*
     * The number MSG91 verified, against the number this request is about. They
     * differ when a caller verifies a handset they own and then asks us to mark a
     * different number as theirs — which is the whole attack this check exists
     * for, and the reason the phone is never simply taken from the request.
     */
    if (verifiedPhone !== phone) {
      throw appError("VALIDATION", "That code was sent to a different number. Please verify the number you entered.");
    }

    (await cookies()).set(OTP_COOKIE, issueVerifiedPhoneCookie(phone), {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: OTP_VERIFIED_MAX_AGE,
    });

    return ok({ verified: true, phone });
  } catch (err) {
    return fail(err, { route: "POST /api/otp/widget-verify" });
  }
}
