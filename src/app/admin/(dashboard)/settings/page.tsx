import type { Metadata } from "next";
import { getSettings } from "@/lib/settings";
import { razorpayConfigured, razorpayLiveMode, razorpayWebhookConfigured } from "@/lib/razorpay";
import { ownerEmail, resendConfigured } from "@/lib/email";
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
        <p className="text-sm text-ink-600">Business details, how customers pay, and what gets sent to you.</p>
      </div>

      <SettingsForm
        smsReady={smsConfigured()}
        email={{ ready: resendConfigured() && Boolean(ownerEmail()), address: ownerEmail() }}
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
          emailOnBooking: settings.emailOnBooking,
        }}
      />
    </div>
  );
}
