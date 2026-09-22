"use client";

import * as React from "react";
import { ShieldCheck } from "lucide-react";
import { api } from "@/lib/client";
import { Alert, Button, Spinner } from "@/components/ui/primitives";

/**
 * Mobile verification through MSG91's OTP Widget.
 *
 * MSG91's SDK owns the code: it sends it, checks it, counts the wrong guesses and
 * expires it. This component owns only the two things it cannot — collecting a
 * number, and taking the access token MSG91 hands back to our own server, which
 * is the only place it means anything. Nothing here decides that a number is
 * verified; {@link ../../app/api/otp/widget-verify/route} does, and it asks MSG91.
 */

const SDK_URL = "https://verify.msg91.com/otp-provider.js";

/**
 * Where MSG91 mounts its captcha.
 *
 * Not optional, whatever the docs imply. A widget with captcha switched on and no
 * `captchaRenderId` asks an hCaptcha element that was never mounted for a token,
 * and the branch that handles that failure only writes to the console — no
 * success callback, no failure callback, the caller simply waits for ever. The
 * element has to exist before the first send.
 */
const CAPTCHA_ELEMENT_ID = "msg91-captcha";

/**
 * Which channel a resend goes out on. 11 is SMS; MSG91 also has 12 (WhatsApp),
 * 4 (voice) and 3 (email) configured as retry channels on this widget.
 *
 * Not optional on a "Custom" widget, whatever the default argument suggests: the
 * SDK's retry path calls its own validator without a failure callback, so a null
 * channel throws an internal error rather than reporting one.
 */
const RETRY_CHANNEL_SMS = "11";

/** The SDK's success and failure callbacks, which carry `{ message, type }`. */
type WidgetCallback = (data: { message?: string; type?: string } | string) => void;

declare global {
  interface Window {
    initSendOTP?: (config: Record<string, unknown>) => void;
    sendOtp?: (identifier: string, success: WidgetCallback, failure: WidgetCallback) => void;
    verifyOtp?: (otp: string, success: WidgetCallback, failure: WidgetCallback) => void;
    retryOtp?: (channel: string | null, success: WidgetCallback, failure: WidgetCallback) => void;
  }
}

/** Whatever the SDK passed, as something worth putting in front of a person. */
function widgetMessage(data: { message?: string; type?: string } | string, fallback: string): string {
  const raw = typeof data === "string" ? data : (data?.message ?? "");
  const text = String(raw).trim();
  if (!text) return fallback;
  // MSG91's own wording is written for a customer and is more specific than
  // anything generic — "OTP expired", "Invalid OTP", "OTP not match".
  return text.charAt(0).toUpperCase() + text.slice(1);
}

let sdkPromise: Promise<void> | null = null;

/**
 * Load the SDK once per page, whatever else mounts.
 *
 * Kept as a module-level promise rather than component state because two copies
 * of the script would register two widgets and the second `initSendOTP` would win
 * — the sort of bug that only shows up once this is used on more than one screen.
 */
function loadSdk(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if (window.initSendOTP) return Promise.resolve();
  if (sdkPromise) return sdkPromise;

  sdkPromise = new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SDK_URL;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      // A failed load must be retryable: a customer on a bad connection who
      // reloads should get another attempt, not a permanently dead button.
      sdkPromise = null;
      reject(new Error("sdk"));
    };
    document.head.appendChild(script);
  });
  return sdkPromise;
}

export interface Msg91OtpWidgetProps {
  widgetId: string;
  tokenAuth: string;
  /**
   * The number to verify, when the surrounding form already asked for one.
   * Leave it out and the widget collects its own — which is what the test page
   * does. Booking asks for a mobile number anyway, and asking twice invites the
   * customer to verify one number and book with another.
   */
  phone?: string;
  /** Called with the ten-digit number once OUR server has confirmed it with MSG91. */
  onVerified?: (phone: string) => void;
}

type Stage = "number" | "code" | "done";

/**
 * How long before "Resend code" comes back.
 *
 * MSG91 has its own retry window per widget — 10 seconds on this account — and
 * refuses a retry inside it. This is deliberately a little longer, so the button
 * is never offered for a request that would bounce.
 */
const RESEND_SECONDS = 15;

export function Msg91OtpWidget({ widgetId, tokenAuth, phone: given, onVerified }: Msg91OtpWidgetProps) {
  const controlled = given !== undefined;
  const [stage, setStage] = React.useState<Stage>("number");
  const [ownPhone, setOwnPhone] = React.useState("");
  const phone = controlled ? given : ownPhone;
  const [code, setCode] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [resendIn, setResendIn] = React.useState(0);
  const [ready, setReady] = React.useState(false);
  const [captchaReady, setCaptchaReady] = React.useState(false);
  /** Whether this widget asks for a captcha at all — only MSG91 knows. */
  const [captchaRequired, setCaptchaRequired] = React.useState(false);

  const phoneDigits = phone.replace(/\D/g, "").slice(-10);
  const phoneValid = /^[6-9]\d{9}$/.test(phoneDigits);

  /*
   * Editing the number in the form outside invalidates everything here: a code
   * already sent went to the old number, and a verification already made was of
   * the old number. Both have to go back to the start.
   */
  React.useEffect(() => {
    if (!controlled) return;
    setStage("number");
    setCode("");
    setError(null);
    setNotice(null);
    setResendIn(0);
  }, [controlled, phoneDigits]);

  /* ── The widget itself ──────────────────────────────────────────────── */

  React.useEffect(() => {
    let cancelled = false;
    loadSdk()
      .then(() => {
        if (cancelled) return;
        window.initSendOTP?.({
          widgetId,
          tokenAuth,
          // Without this the SDK renders its own modal. We drive it instead, so
          // the number and code sit in this site's own fields.
          exposeMethods: true,
          // Not a typo for the line above: the SDK spells it both ways, and it is
          // this one it checks before calling `captchaVerified`.
          exposedMethods: true,
          captchaRenderId: CAPTCHA_ELEMENT_ID,
          captchaVerified: (passed: boolean) => setCaptchaReady(Boolean(passed)),
          success: () => {},
          failure: () => {},
        });
        setReady(true);
      })
      .catch(() => {
        if (!cancelled) setError("We could not load the verification service. Check your connection and try again.");
      });
    return () => {
      cancelled = true;
    };
  }, [widgetId, tokenAuth]);

  /*
   * Whether a captcha is in play is a setting on MSG91's side, not ours, and the
   * SDK never says. What it does is mount one — so the appearance of a child in
   * the mount point is the signal. Watched rather than polled, because a slow
   * captcha would beat any delay worth waiting.
   */
  React.useEffect(() => {
    const mount = document.getElementById(CAPTCHA_ELEMENT_ID);
    if (!mount) return;
    if (mount.children.length > 0) setCaptchaRequired(true);
    const observer = new MutationObserver(() => {
      if (mount.children.length > 0) setCaptchaRequired(true);
    });
    observer.observe(mount, { childList: true });
    return () => observer.disconnect();
  }, [ready]);

  React.useEffect(() => {
    if (resendIn <= 0) return;
    const timer = window.setTimeout(() => setResendIn((n) => n - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [resendIn]);

  /** Promise wrapper: the SDK is callback-based and every step here is a step in a sequence. */
  const call = React.useCallback(
    (
      method: (success: WidgetCallback, failure: WidgetCallback) => void,
      fallback: string,
    ): Promise<{ message?: string; type?: string } | string> =>
      new Promise((resolve, reject) => {
        let settled = false;
        // The SDK gives no guarantee that a callback ever fires — a dropped
        // connection mid-request simply goes quiet. Without this the button
        // spins for ever.
        const timeout = window.setTimeout(() => {
          if (settled) return;
          settled = true;
          reject(new Error("The verification service did not respond. Please try again."));
        }, 20000);
        const finish = (fn: () => void) => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timeout);
          fn();
        };
        method(
          (data) => finish(() => resolve(data)),
          (data) => finish(() => reject(new Error(widgetMessage(data, fallback)))),
        );
      }),
    [],
  );

  /* ── Steps ──────────────────────────────────────────────────────────── */

  async function send() {
    setError(null);
    setNotice(null);
    if (!phoneValid) {
      setError("Enter a 10-digit Indian mobile number.");
      return;
    }
    setBusy(true);
    try {
      // MSG91 wants the country code on the identifier.
      await call((s, f) => window.sendOtp?.(`91${phoneDigits}`, s, f), "We could not send the code. Please try again.");
      setStage("code");
      setResendIn(RESEND_SECONDS);
      setNotice(`Code sent to +91 ${phoneDigits}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "We could not send the code. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function resend() {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      await call(
        (s, f) => window.retryOtp?.(RETRY_CHANNEL_SMS, s, f),
        "We could not resend the code. Please try again.",
      );
      setResendIn(RESEND_SECONDS);
      setNotice("A new code is on its way.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "We could not resend the code. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function verify() {
    setError(null);
    setNotice(null);
    if (!/^\d{4,8}$/.test(code.trim())) {
      setError("Enter the code exactly as you received it.");
      return;
    }
    setBusy(true);
    try {
      const result = await call(
        (s, f) => window.verifyOtp?.(code.trim(), s, f),
        "That code is not correct. Please check and try again.",
      );
      const accessToken = typeof result === "string" ? result : (result?.message ?? "");
      if (!accessToken) throw new Error("Verification did not complete. Please request a new code.");

      /*
       * The only step that decides anything. Up to here MSG91 has told the
       * browser it is happy, and the browser is not a witness we can use — the
       * server spends this token against MSG91 itself before any number counts
       * as verified.
       */
      const confirmed = await api<{ verified: boolean; phone: string }>("/api/otp/widget-verify", {
        method: "POST",
        body: JSON.stringify({ phone: phoneDigits, accessToken }),
      });

      setStage("done");
      setNotice(null);
      onVerified?.(confirmed.phone);
    } catch (err) {
      setError(err instanceof Error ? err.message : "We could not verify that code. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  /* ── Screen ─────────────────────────────────────────────────────────── */

  if (stage === "done") {
    return (
      <Alert tone="success">
        <span className="inline-flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 shrink-0" aria-hidden="true" />
          +91 {phoneDigits} is verified.
        </span>
      </Alert>
    );
  }

  return (
    <div className="space-y-3">
      {/* MSG91 mounts its captcha here. Rendered on every stage: removing it
          between steps takes the token with it. An invisible captcha draws
          nothing, and a visible one has to be visible, so this is never hidden. */}
      <div id={CAPTCHA_ELEMENT_ID} />

      {stage === "number" ? (
        <>
          {controlled ? (
            <p className="text-sm text-ink-300">
              {phoneValid ? (
                <>
                  We will text a code to <strong className="text-white">+91 {phoneDigits}</strong>.
                </>
              ) : (
                "Enter your mobile number above to verify it."
              )}
            </p>
          ) : (
            <>
              <label className="block text-sm font-medium text-ink-200" htmlFor="otp-phone">
                Mobile number
              </label>
              <div className="flex gap-2">
                <span className="flex h-11 items-center rounded-lg border border-white/15 bg-white/5 px-3 text-sm text-ink-300">
                  +91
                </span>
                <input
                  id="otp-phone"
                  inputMode="numeric"
                  autoComplete="tel-national"
                  maxLength={10}
                  value={ownPhone}
                  onChange={(e) => setOwnPhone(e.target.value.replace(/\D/g, "").slice(0, 10))}
                  placeholder="9876543210"
                  className="h-11 w-full rounded-lg border border-white/15 bg-white/5 px-3 text-white placeholder:text-ink-500"
                />
              </div>
            </>
          )}
          <Button
            className="w-full"
            disabled={busy || !ready || !phoneValid || (captchaRequired && !captchaReady)}
            onClick={send}
          >
            {busy ? <Spinner /> : null}
            {ready ? "Send code" : "Loading…"}
          </Button>
          {captchaRequired && !captchaReady ? (
            <p className="text-sm text-ink-400">Tick the box above to show you are not a robot.</p>
          ) : null}
        </>
      ) : (
        <>
          <label className="block text-sm font-medium text-ink-200" htmlFor="otp-code">
            Code sent to +91 {phoneDigits}
          </label>
          <input
            id="otp-code"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={8}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 8))}
            placeholder="123456"
            className="h-11 w-full rounded-lg border border-white/15 bg-white/5 px-3 tracking-[0.3em] text-white placeholder:tracking-normal placeholder:text-ink-500"
          />
          <Button className="w-full" disabled={busy} onClick={verify}>
            {busy ? <Spinner /> : null}
            Verify
          </Button>
          <div className="flex items-center justify-between text-sm">
            <button
              type="button"
              className="text-ink-300 underline underline-offset-4 hover:text-white disabled:no-underline disabled:opacity-60"
              disabled={busy || resendIn > 0}
              onClick={resend}
            >
              {resendIn > 0 ? `Send again in ${resendIn}s` : "Didn't get it? Send again"}
            </button>
            {controlled ? null : (
              <button
                type="button"
                className="text-ink-300 underline underline-offset-4 hover:text-white"
                disabled={busy}
                onClick={() => {
                  setStage("number");
                  setCode("");
                  setError(null);
                  setNotice(null);
                }}
              >
                Change number
              </button>
            )}
          </div>
        </>
      )}

      {notice ? <Alert tone="info">{notice}</Alert> : null}
      {error ? <Alert tone="error">{error}</Alert> : null}
    </div>
  );
}
