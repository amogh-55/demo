import Link from "next/link";
import type { Metadata } from "next";
import { getSettings } from "@/lib/settings";
import { CallUs, LegalList, LegalPage, LegalSection } from "@/components/customer/legal-page";

export const revalidate = 300;

export const metadata: Metadata = {
  title: "Terms & Conditions",
  description: "The terms that apply to every booking.",
};

export default async function TermsPage() {
  const { businessName } = await getSettings();

  return (
    <LegalPage businessName={businessName} title="Terms & Conditions">
      <p>
        These terms apply to every booking made with {businessName} — on this website, by phone or at the ground — at
        any of our grounds in Hyderabad. By making a booking you agree to them.
      </p>

      <LegalSection title="Bookings">
        <LegalList>
          <li>
            A slot is yours once your booking is confirmed. You see the confirmation on screen and can download a
            receipt.
          </li>
          <li>
            Bookings paid by UPI screenshot are confirmed after our team has checked the payment. Until then the slot
            is held for you but not confirmed.
          </li>
          <li>The price shown when you book is the price you pay. All prices are in Indian Rupees (₹).</li>
          <li>
            Where a booking is paid partly in advance or at the ground, the amount due at the ground is shown before you
            book and must be paid before play starts.
          </li>
        </LegalList>
      </LegalSection>

      <LegalSection title="Payments">
        <p>
          Online payments are processed securely by Razorpay. We never see or store your card or UPI PIN details.
        </p>
      </LegalSection>

      <LegalSection title="No cancellations, no refunds">
        <p>
          Once booked, a booking cannot be cancelled and no refund is given. See the{" "}
          <Link href="/refund-policy" className="font-medium text-lime-400 hover:text-lime-300">
            Cancellation &amp; Refund Policy
          </Link>
          .
        </p>
      </LegalSection>

      <LegalSection title="Your slot">
        <LegalList>
          <li>Please arrive on time. A slot ends at its booked time, even if play started late.</li>
          <li>Follow the instructions of the ground staff at all times.</li>
        </LegalList>
      </LegalSection>

      <LegalSection title="Injuries and personal belongings">
        <LegalList>
          <li>
            Cricket, bowling-machine practice, pickleball and every other activity at our grounds carry a risk of
            injury. You take part entirely at your own risk.
          </li>
          <li>
            {businessName}, its owners and its staff are not responsible for any injury, accident, illness, loss or
            damage suffered by anyone using our grounds or facilities, or for the loss of or damage to any personal
            belongings.
          </li>
          <li>Use proper protective gear. Parents and guardians are responsible for any minors they bring.</li>
        </LegalList>
      </LegalSection>

      <LegalSection title="How the service is delivered">
        <p>
          We provide sports facilities, not goods — nothing is shipped. The service is delivered at the ground you
          booked, on the date and time shown on your confirmation.
        </p>
      </LegalSection>

      <LegalSection title="Changes and law">
        <p>
          We may update these terms; the version on this page applies to bookings made from its date. These terms are
          governed by the laws of India, and the courts at Hyderabad have jurisdiction.
        </p>
      </LegalSection>

      <LegalSection title="Questions">
        <p>
          Call us on <CallUs />.
        </p>
      </LegalSection>
    </LegalPage>
  );
}
