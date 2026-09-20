import { fail, ok } from "@/lib/api";
import { endSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    await endSession();
    return ok({ signedOut: true });
  } catch (err) {
    return fail(err, { route: "POST /api/admin/logout" });
  }
}
