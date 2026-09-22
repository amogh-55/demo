import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { widgetConfig, widgetVerifyConfigured } from "@/lib/msg91-widget";
import { Alert } from "@/components/ui/primitives";
import { OtpTestHarness } from "@/components/customer/otp-test-harness";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "OTP widget test",
  robots: { index: false, follow: false },
};

/**
 * A bench for the MSG91 widget, on its own, away from the booking flow.
 *
 * Every send here spends the owner's SMS balance, so it is not reachable on the
 * deployed site unless someone deliberately sets OTP_TEST_PAGE=1. Locally it is
 * always on.
 */
export default function OtpTestPage() {
  if (process.env.NODE_ENV === "production" && process.env.OTP_TEST_PAGE !== "1") notFound();

  const config = widgetConfig();
  const canVerify = widgetVerifyConfigured();

  return (
    <div className="min-h-dvh bg-ink-950">
      <main id="main" className="container max-w-lg py-10 sm:py-16">
        <h1 className="text-2xl font-bold text-white">OTP widget test</h1>
        <p className="mt-2 text-sm text-ink-400">
          MSG91 sends and checks the code. This server then spends the access token against MSG91 with its own AuthKey,
          and only that decides whether the number counts as verified.
        </p>

        {!config ? (
          <Alert tone="error" className="mt-6">
            MSG91_WIDGET_ID and MSG91_WIDGET_TOKEN are not set, so the widget cannot load.
          </Alert>
        ) : !canVerify ? (
          <Alert tone="error" className="mt-6">
            MSG91_AUTH_KEY is not set. The widget would load, but the server could not confirm anything it returned —
            which is the only step that counts.
          </Alert>
        ) : (
          <div className="card mt-6">
            <OtpTestHarness widgetId={config.widgetId} tokenAuth={config.tokenAuth} />
          </div>
        )}
      </main>
    </div>
  );
}
