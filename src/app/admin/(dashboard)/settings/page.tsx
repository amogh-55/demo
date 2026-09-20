import type { Metadata } from "next";
import { getSettings } from "@/lib/settings";
import { SettingsForm } from "@/components/admin/settings-form";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Settings", robots: { index: false } };

export default async function AdminSettingsPage() {
  const settings = await getSettings();

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div>
        <h1 className="text-xl font-bold text-ink-900">Settings</h1>
        <p className="text-sm text-ink-600">Business details and UPI payment information.</p>
      </div>

      <SettingsForm
        initial={{
          businessName: settings.businessName,
          supportPhone: settings.supportPhone,
          whatsappNumber: settings.whatsappNumber,
          upiId: settings.upiId,
          upiPayeeName: settings.upiPayeeName,
          upiQrImageUrl: settings.upiQrImageUrl,
        }}
      />
    </div>
  );
}
