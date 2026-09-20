import type { Metadata, Viewport } from "next";
import { Poppins } from "next/font/google";
import "./globals.css";

/**
 * Self-hosted by Next at build time, so there is no request to Google at runtime
 * and no layout shift while it loads. Only the weights actually used are shipped.
 */
const poppins = Poppins({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-poppins",
  display: "swap",
});

const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
const businessName = process.env.NEXT_PUBLIC_BUSINESS_NAME || "Cricket Turf Arena";

export const metadata: Metadata = {
  metadataBase: new URL(appUrl),
  title: {
    default: `${businessName} — Book a cricket turf near you`,
    template: `%s · ${businessName}`,
  },
  description:
    "Book floodlit cricket turfs by the hour across three locations. Pick your ground, choose a slot, pay by UPI and get confirmed on WhatsApp.",
  openGraph: {
    type: "website",
    siteName: businessName,
    title: `${businessName} — Book a cricket turf near you`,
    description: "Three floodlit grounds. Hourly slots. Instant UPI payment and WhatsApp confirmation.",
    url: appUrl,
    images: [{ url: "/images/hero-turf-action.jpg", width: 1200, height: 630, alt: `${businessName} cricket turf` }],
  },
  icons: { icon: "/favicon.svg" },
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  themeColor: "#0b0e13",
  width: "device-width",
  initialScale: 1,
  // Lets the page paint into the notch area, and is what makes
  // env(safe-area-inset-*) report a real value — the admin tab bar and the
  // customer booking bar both sit above the iPhone home indicator because of it.
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-IN" className={poppins.variable}>
      {/* The dark surface comes from globals.css, so an overscroll bounce does not
          flash white; the admin shell paints itself light on top. */}
      <body className="min-h-dvh">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-pitch-700 focus:px-4 focus:py-2 focus:text-white"
        >
          Skip to content
        </a>
        {children}
      </body>
    </html>
  );
}
