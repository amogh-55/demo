import { redirect } from "next/navigation";

/** Grounds and prices moved under Settings. Kept so a saved link still lands somewhere. */
export default function AdminLocationsPage() {
  redirect("/admin/settings");
}
