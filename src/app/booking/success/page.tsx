import Link from "next/link";
import { cookies } from "next/headers";
import type { Metadata } from "next";
import { CheckCircle2 } from "lucide-react";
import { LAST_BOOKING_COOKIE } from "@/lib/api";
import { readSignedCookieValue } from "@/lib/auth";
import { collections, getDb } from "@/lib/db";
import { getSettings } from "@/lib/settings";
import { formatBusinessDate, formatIstTimestamp, formatRange, minutesToDuration } from "@/lib/time";
import { Alert, Button, formatCurrency } from "@/components/ui/primitives";
import { ReceiptActions } from "@/components/customer/receipt-actions";
import { customerIntroMessage, whatsappUrl } from "@/lib/whatsapp";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Booking request submitted",
  robots: { index: false, follow: false },
};

/**
 * The booking is looked up from the caller's own httpOnly cookie rather than from a
 * reference in the URL, so nobody can read someone else's booking by guessing a
 * reference.
 */
export default async function BookingSuccessPage() {
  // Verified, not just read: the cookie is signed so a forwarded booking
  // reference cannot be pasted in to read someone else's name and phone number.
  const reference = readSignedCookieValue((await cookies()).get(LAST_BOOKING_COOKIE)?.value);
  const settings = await getSettings();
  const booking = reference ? await collections.bookings(await getDb()).findOne({ reference }) : null;

  if (!booking) {
    return (
      <div className="min-h-dvh bg-ink-950">
        <main id="main" className="container max-w-xl py-10 sm:py-16">
          <div className="card text-center">
            <h1 className="text-xl font-bold text-white">We could not find your booking on this device</h1>
            <p className="mt-2 text-sm text-ink-400">
              If you just submitted a request, keep the booking reference you were shown. The turf team will still
              contact you on WhatsApp once your payment is verified.
            </p>
            <Link href="/" className="mt-5 inline-block">
              <Button variant="secondary">Back to home</Button>
            </Link>
          </div>
        </main>
      </div>
    );
  }

  const location = await collections.locations(await getDb()).findOne({ _id: booking.locationId });

  return (
    <div className="min-h-dvh bg-ink-950">
      <main id="main" className="container max-w-xl py-10 sm:py-16">
        <div className="card receipt print:bg-white">
          {/* Only appears on the printed copy, so the page itself stays uncluttered. */}
          <div className="print-only mb-4 border-b border-white/15 pb-3">
            <p className="text-lg font-bold">{settings.businessName}</p>
            <p className="text-sm">Booking request — awaiting payment verification</p>
            <p className="mt-1 text-xs">Issued {formatIstTimestamp(booking.createdAt)} IST</p>
          </div>

          <div className="text-center">
            <CheckCircle2 className="no-print mx-auto h-12 w-12 text-lime-400" aria-hidden="true" />
            <h1 className="mt-3 text-2xl font-bold text-white">Booking request submitted</h1>

            <p className="mt-5 text-xs font-semibold uppercase tracking-wide text-ink-400">Booking reference</p>
            <p className="mt-1 break-words text-2xl font-bold tracking-wider text-lime-400 sm:text-3xl">
              {booking.reference}
            </p>
            <p className="mt-1 text-sm text-ink-400">Save this — quote it if you call us.</p>
          </div>

          <dl className="mt-6 divide-y divide-white/10 border-t border-white/10 pt-2 text-sm">
            <Row label="Ground" value={booking.locationName} />
            {location?.address ? <Row label="Address" value={location.address} /> : null}
            <Row label="Date" value={formatBusinessDate(booking.date)} />
            <Row label="Time" value={formatRange(booking.startMin, booking.endMin)} />
            <Row label="Duration" value={minutesToDuration(booking.endMin - booking.startMin)} />
            <Row label="Booking total" value={formatCurrency(booking.amount)} strong />
            {booking.amountPaid > 0 ? <Row label="Received so far" value={formatCurrency(booking.amountPaid)} /> : null}
            <Row label="Name" value={booking.customerName} />
            <Row label="Mobile" value={`+91 ${booking.customerPhone}`} />
            <Row label="Requested on" value={`${formatIstTimestamp(booking.createdAt)} IST`} />
            <Row
              label="Status"
              value={
                booking.paymentVerificationStatus === "PARTIAL"
                  ? `Balance of ${formatCurrency(booking.amount - booking.amountPaid)} due`
                  : "Awaiting payment verification"
              }
            />
          </dl>

          {booking.paymentVerificationStatus === "PARTIAL" ? (
            <div className="mt-5 rounded-lg border border-amber-400/40 bg-amber-400/15 p-4 text-sm">
              <p className="font-semibold text-amber-100">
                Balance due: {formatCurrency(booking.amount - booking.amountPaid)}
              </p>
              <p className="mt-1 text-amber-100">
                We received {formatCurrency(booking.amountPaid)} of {formatCurrency(booking.amount)}.{" "}
                <strong>Your slot is still reserved.</strong> Please pay the balance and send us the screenshot to
                confirm your booking.
              </p>
            </div>
          ) : null}

          <div className="mt-5 rounded-lg border border-amber-400/30 bg-amber-400/10 p-4 text-sm">
            <p className="font-semibold text-amber-100">What happens next</p>
            <ol className="mt-2 space-y-1.5 text-amber-100">
              <li>
                <strong>1.</strong> We check your payment screenshot against the amount above.
              </li>
              <li>
                <strong>2.</strong> Once the payment is verified, we message you on WhatsApp to confirm your slot.
              </li>
            </ol>
            <p className="mt-3 border-t border-amber-200 pt-2 text-amber-100">
              Your slot is held for you while we check. <strong>This is not a confirmation yet</strong> — it becomes
              confirmed only after we verify the payment and message you.
            </p>
          </div>

          <p className="print-only mt-4 border-t border-white/15 pt-3 text-xs">
            This document records a booking request only. It is not proof of a confirmed booking or of payment
            received.
            {settings.supportPhone ? ` Queries: +91 ${settings.supportPhone}.` : ""}
          </p>
        </div>

        <div className="no-print mt-5 space-y-2">
          <ReceiptActions reference={booking.reference} />
          <div className="flex flex-col gap-2 sm:flex-row">
            {settings.whatsappNumber ? (
              <a
                className="flex-1"
                target="_blank"
                rel="noopener noreferrer"
                href={whatsappUrl(settings.whatsappNumber, customerIntroMessage(booking))}
              >
                <Button variant="whatsapp" className="w-full">
                  Message the turf
                </Button>
              </a>
            ) : null}
            <Link href="/" className="flex-1">
              <Button variant="secondary" className="w-full">
                Back to home
              </Button>
            </Link>
          </div>
        </div>

        <Alert tone="info" className="no-print mt-4">
          Tip: choose <strong>Save as PDF</strong> in the print dialog to keep a copy on your phone.
        </Alert>
      </main>
    </div>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    // The label keeps its width so a long ground name or address wraps in the value
    // column instead of pushing the row wider than the phone.
    <div className="flex justify-between gap-3 py-2.5">
      <dt className="shrink-0 text-ink-400">{label}</dt>
      <dd
        className={
          strong
            ? "min-w-0 break-words text-right text-base font-bold text-white"
            : "min-w-0 break-words text-right font-medium text-ink-200"
        }
      >
        {value}
      </dd>
    </div>
  );
}
