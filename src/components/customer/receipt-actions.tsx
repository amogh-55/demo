"use client";

import { Download } from "lucide-react";
import { Button } from "@/components/ui/primitives";

/**
 * Downloading the receipt hands off to the browser's own print dialog, which
 * offers "Save as PDF" on desktop, Android Chrome and iOS Safari alike. That
 * beats shipping a PDF library, and unlike a hand-built PDF it renders ₹
 * correctly without embedding a font.
 */
export function ReceiptActions({ reference }: { reference: string }) {
  return (
    <Button
      variant="secondary"
      className="w-full"
      onClick={() => {
        // The filename the browser suggests comes from the document title.
        const previous = document.title;
        document.title = `${reference} booking request`;
        window.print();
        // Restore it once the dialog has taken its snapshot.
        window.setTimeout(() => {
          document.title = previous;
        }, 1000);
      }}
    >
      <Download className="h-4 w-4" aria-hidden="true" />
      Download receipt
    </Button>
  );
}
