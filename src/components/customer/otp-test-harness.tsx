"use client";

import * as React from "react";
import { api } from "@/lib/client";
import { Alert, Button } from "@/components/ui/primitives";
import { Msg91OtpWidget } from "./msg91-otp-widget";

/**
 * The widget, plus the one thing looking at the widget cannot tell you.
 *
 * "Verified" in this page's own state is just a variable. The check below asks
 * the server what it holds in its signed httpOnly cookie — the state the booking
 * route will actually act on, which the browser can neither read nor forge.
 */
export function OtpTestHarness({ widgetId, tokenAuth }: { widgetId: string; tokenAuth: string }) {
  const [serverSays, setServerSays] = React.useState<string | null>(null);
  const [checking, setChecking] = React.useState(false);

  async function check() {
    setChecking(true);
    try {
      const status = await api<{ verified: boolean; phone: string | null }>("/api/otp/status");
      setServerSays(status.verified ? `Server holds a verification for +91 ${status.phone}.` : "Server holds no verification for this browser.");
    } catch {
      setServerSays("Could not reach the server.");
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="space-y-4">
      <Msg91OtpWidget widgetId={widgetId} tokenAuth={tokenAuth} onVerified={() => void check()} />

      <div className="border-t border-white/10 pt-4">
        <Button variant="secondary" className="w-full" disabled={checking} onClick={check}>
          {checking ? "Checking…" : "Ask the server what it holds"}
        </Button>
        {serverSays ? (
          <Alert tone="info" className="mt-3">
            {serverSays}
          </Alert>
        ) : null}
      </div>
    </div>
  );
}
