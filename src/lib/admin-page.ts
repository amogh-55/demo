import "server-only";
import { redirect } from "next/navigation";
import { getSession, type AdminSession } from "./auth";

/**
 * The admin gate for PAGES, which redirect rather than answer 401.
 *
 * Every page that loads data calls this itself. The dashboard layout's check is
 * not enough on its own: on a client-side navigation Next renders only the
 * segments that changed, so a hand-built RSC request naming the layout as
 * "already on screen" gets the page's payload without the layout ever running.
 *
 * Kept out of auth.ts so the cookie-signing code the tests import does not drag
 * in next/navigation, which only loads inside Next itself.
 */
export async function requireAdminPage(): Promise<AdminSession> {
  const session = await getSession();
  if (!session) redirect("/admin/login");
  return session;
}
