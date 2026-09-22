"use client";

import * as React from "react";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/primitives";

/**
 * Download the receipt as a real PDF file.
 *
 * This used to open the browser's print dialog and leave the customer to find
 * "Save as PDF" in it — which is two menus deep on Android and not where anyone
 * looks after pressing a button labelled Download. The server builds the file;
 * this only asks for it.
 *
 * Fetched rather than linked so a failure can be reported here instead of
 * replacing the page the customer is reading with an error document.
 */
export function ReceiptActions({ reference }: { reference: string }) {
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function download() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/bookings/receipt");
      if (!response.ok) throw new Error("receipt");
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${reference}.pdf`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      // Freed on the next tick: revoking immediately cancels the download in Safari.
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch {
      setError("We could not build your receipt. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <Button variant="secondary" className="w-full" disabled={busy} onClick={() => void download()}>
        <Download className="h-4 w-4" aria-hidden="true" />
        {busy ? "Preparing…" : "Download receipt"}
      </Button>
      {error ? <p className="mt-2 text-center text-sm text-red-400">{error}</p> : null}
    </div>
  );
}
