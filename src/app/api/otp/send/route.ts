import { fail, ok, readJson } from "@/lib/api";
import { appError } from "@/lib/errors";
import { otpRequired, sendOtp } from "@/lib/otp";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import { otpSendSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

/**
 * Send a one-time code to a mobile number.
 *
 * Every send costs the owner money, so this is limited twice over: by number, in
 * {@link sendOtp} itself, which enforces the resend cooldown and the per-number
 * ceiling; and by network address here, which is what stops one script burning
 * through the SMS balance across a thousand different numbers.
 */
export async function POST(request: Request) {
  try {
    // Indian mobile networks put many subscribers behind one address, so this is
    // set well above what a person does and only catches automated abuse.
    await rateLimit(`otp-send-ip:${clientIp(request.headers)}`, 20, 3600, { shared: true });

    if (!(await otpRequired())) {
      throw appError("VALIDATION", "Mobile verification is not switched on.");
    }

    const { phone } = otpSendSchema.parse(await readJson(request));
    await rateLimit(`otp-send:${phone}`, 5, 3600, { shared: true });

    const result = await sendOtp(phone);
    // `delivered: false` means no SMS provider is configured. Said plainly rather
    // than showing a code entry box for a message that will never arrive.
    return ok({ sent: true, resendAfterSeconds: result.resendAfterSeconds, delivered: result.delivered });
  } catch (err) {
    return fail(err, { route: "POST /api/otp/send" });
  }
}
