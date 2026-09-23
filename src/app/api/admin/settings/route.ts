import { fail, ok, readJson } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { getSettings, saveSettings } from "@/lib/settings";
import { settingsSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await requireAdmin();
    const settings = await getSettings();
    return ok({
      settings: {
        businessName: settings.businessName,
        supportPhone: settings.supportPhone,
        whatsappNumber: settings.whatsappNumber,
        upiId: settings.upiId,
        upiPayeeName: settings.upiPayeeName,
        upiQrImageUrl: settings.upiQrImageUrl,
        otpEnabled: settings.otpEnabled,
        razorpayEnabled: settings.razorpayEnabled,
        notifyPhone: settings.notifyPhone,
        notifyOnNewBooking: settings.notifyOnNewBooking,
      },
    });
  } catch (err) {
    return fail(err, { route: "GET /api/admin/settings" });
  }
}

export async function PUT(request: Request) {
  try {
    const admin = await requireAdmin();
    const input = settingsSchema.parse(await readJson(request));
    const saved = await saveSettings(input);
    // The UPI id itself is scrubbed by the logger; only the fact of a change is recorded.
    // The SMS switches ARE recorded by value: turning them on starts spending the
    // owner's money, so who did it and when belongs in the audit trail.
    return ok({
      saved: true,
      settings: {
        otpEnabled: saved.otpEnabled,
        razorpayEnabled: saved.razorpayEnabled,
        notifyOnNewBooking: saved.notifyOnNewBooking,
      },
    });
  } catch (err) {
    return fail(err, { route: "PUT /api/admin/settings" });
  }
}
