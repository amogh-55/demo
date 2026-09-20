import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { AdminShell } from "@/components/admin/admin-shell";

export const dynamic = "force-dynamic";

/**
 * Gate for every admin page. /admin/login sits outside this route group so it can
 * render without a session. The API routes re-check the session themselves — this
 * layout is convenience, not the security boundary.
 */
export default async function AdminDashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect("/admin/login");

  return <AdminShell session={session}>{children}</AdminShell>;
}
