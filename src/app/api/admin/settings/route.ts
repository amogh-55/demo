import { fail, ok, readJson } from "@/lib/api";
import { recordAudit, requireAdmin } from "@/lib/auth";
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
    await saveSettings(input);
    // The UPI id itself is scrubbed by the logger; only the fact of a change is recorded.
    await recordAudit(admin, "SETTINGS_UPDATED", "settings", "business", { fields: Object.keys(input) });
    return ok({ saved: true });
  } catch (err) {
    return fail(err, { route: "PUT /api/admin/settings" });
  }
}
