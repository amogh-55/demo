import type { Metadata } from "next";
import { getSettings } from "@/lib/settings";
import { CallUs, LegalList, LegalPage, LegalSection } from "@/components/customer/legal-page";

export const revalidate = 300;

export const metadata: Metadata = {
  title: "Cancellation & Refund Policy",
  description: "Bookings are final: no cancellations and no refunds.",
};

export default async function RefundPolicyPage() {
  const { businessName } = await getSettings();

  return (
    <LegalPage businessName={businessName} title="Cancellation & Refund Policy">
      <LegalSection title="All bookings are final">
        <p>
          Once a booking is made with {businessName}, it <strong className="text-white">cannot be cancelled</strong>{" "}
          and <strong className="text-white">no refund is given</strong>. This applies however the booking was paid —
          online, by UPI, or at the ground — and whatever the reason, including:
        </p>
        <LegalList>
          <li>not turning up, or arriving late;</li>
          <li>a change of plans;</li>
          <li>playing for less than the booked time.</li>
        </LegalList>
        <p>Please check the ground, date and time carefully before you pay.</p>
      </LegalSection>

      <LegalSection title="Failed or duplicate payments">
        <p>
          If money left your account but no booking was confirmed, or you were charged twice for the same booking, call
          us with your payment details. That amount is refunded to the original payment method. Banks usually take 5–7
          working days to show it.
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
