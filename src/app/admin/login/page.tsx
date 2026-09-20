import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { getSession } from "@/lib/auth";
import { LoginForm } from "@/components/admin/login-form";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Staff sign in",
  robots: { index: false, follow: false },
};

export default async function AdminLoginPage() {
  if (await getSession()) redirect("/admin");

  return (
    <div className="theme-light grid min-h-dvh place-items-center bg-ink-50 px-4 text-ink-900">
      <main id="main" className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <span className="mx-auto grid h-12 w-12 place-items-center rounded-xl bg-pitch-600 text-lg text-white">🏏</span>
          <h1 className="mt-3 text-xl font-bold text-ink-900">Staff sign in</h1>
          <p className="mt-1 text-sm text-ink-600">Turf booking administration</p>
        </div>
        <LoginForm />
      </main>
    </div>
  );
}
