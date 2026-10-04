import type { Metadata } from "next";
import { SCREENSHOT_RETAIN_DAYS } from "@/lib/booking/service";
import { getSettings } from "@/lib/settings";
import { CallUs, LegalList, LegalPage, LegalSection } from "@/components/customer/legal-page";

export const revalidate = 300;

export const metadata: Metadata = {
  title: "Privacy Policy",
  description: "What we collect when you book, and what we do with it.",
};

export default async function PrivacyPage() {
  const { businessName } = await getSettings();

  return (
    <LegalPage businessName={businessName} title="Privacy Policy">
      <p>This policy explains what {businessName} collects when you book with us, and what happens to it.</p>

      <LegalSection title="What we collect">
        <LegalList>
          <li>Your name and mobile number.</li>
          <li>The details of your booking: ground, date, time and amount.</li>
          <li>Your payment reference, and the payment screenshot if you upload one.</li>
        </LegalList>
        <p>
          Card and UPI details you enter in the Razorpay payment window go straight to Razorpay. We never see or store
          them.
        </p>
      </LegalSection>

      <LegalSection title="Why we use it">
        <p>
          Only to manage your booking: to hold and confirm your slot, check your payment, and contact you about your
          booking. We do not sell your information or use it for advertising.
        </p>
      </LegalSection>

      <LegalSection title="Who else handles it">
        <LegalList>
          <li>Razorpay, which processes online payments.</li>
          <li>Our SMS provider, if we send you a verification code.</li>
          <li>The hosting and storage providers that run this website and its database for us.</li>
        </LegalList>
      </LegalSection>

      <LegalSection title="How long we keep it">
        <p>
          Payment screenshots are deleted {SCREENSHOT_RETAIN_DAYS} days after the booked date. Booking records are kept
          for our accounts.
        </p>
      </LegalSection>

      <LegalSection title="Cookies">
        <p>
          We use only the cookies this website needs to work: to hold the slot you picked, to remember your booking on
          this device, and to keep staff signed in. No advertising or tracking cookies.
        </p>
      </LegalSection>

      <LegalSection title="Your choices">
        <p>
          To see, correct or delete the information we hold about you, call us on <CallUs />.
        </p>
      </LegalSection>
    </LegalPage>
  );
}
