import type { Metadata } from "next";
import { getSettings } from "@/lib/settings";
import { razorpayConfigured, razorpayLiveMode, razorpayWebhookConfigured } from "@/lib/razorpay";
import { smsConfigured } from "@/lib/sms";
import { SettingsForm } from "@/components/admin/settings-form";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Settings", robots: { index: false } };

export default async function AdminSettingsPage() {
  const settings = await getSettings();

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div>
        <h1 className="text-xl font-bold text-ink-900">Settings</h1>
        <p className="text-sm text-ink-600">Business details, payment information and SMS.</p>
      </div>

      <SettingsForm
        smsReady={smsConfigured()}
        razorpay={{
          ready: razorpayConfigured(),
          webhookReady: razorpayWebhookConfigured(),
          live: razorpayLiveMode(),
        }}
        initial={{
          businessName: settings.businessName,
          supportPhone: settings.supportPhone,
          whatsappNumber: settings.whatsappNumber,
          upiId: settings.upiId,
          upiPayeeName: settings.upiPayeeName,
          upiQrImageUrl: settings.upiQrImageUrl,
          otpEnabled: settings.otpEnabled,
          razorpayEnabled: settings.razorpayEnabled,
          upiScreenshotEnabled: settings.upiScreenshotEnabled,
          notifyPhone: settings.notifyPhone,
          notifyOnNewBooking: settings.notifyOnNewBooking,
        }}
      />
    </div>
  );
}
