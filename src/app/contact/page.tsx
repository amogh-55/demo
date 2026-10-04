import type { Metadata } from "next";
import { Phone } from "lucide-react";
import { getPublicCatalog } from "@/lib/catalog";
import { getSettings } from "@/lib/settings";
import { CallUs, LegalPage, LegalSection } from "@/components/customer/legal-page";

export const revalidate = 300;

export const metadata: Metadata = {
  title: "Contact Us",
  description: "Call us about a booking, or find our grounds.",
};

export default async function ContactPage() {
  const [{ businessName }, locations] = await Promise.all([getSettings(), getPublicCatalog()]);

  return (
    <LegalPage businessName={businessName} title="Contact Us">
      <LegalSection title="Call us">
        <p className="flex items-center gap-2 text-base">
          <Phone className="h-4 w-4 text-lime-400" aria-hidden="true" />
          <CallUs />
        </p>
        <p>For bookings, payments, or anything else about our grounds.</p>
      </LegalSection>

      {locations.length > 0 ? (
        <LegalSection title="Our grounds">
          <ul className="space-y-3">
            {locations.map((l) => (
              <li key={l.id}>
                <p className="font-medium text-white">{l.name}</p>
                {l.address ? <p>{l.address}</p> : null}
                {l.mapsUrl ? (
                  <a href={l.mapsUrl} target="_blank" rel="noopener noreferrer" className="text-lime-400 hover:text-lime-300">
                    Open in Google Maps
                  </a>
                ) : null}
              </li>
            ))}
          </ul>
        </LegalSection>
      ) : null}
    </LegalPage>
  );
}
