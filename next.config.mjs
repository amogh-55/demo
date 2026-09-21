/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  /*
   * Where the build output goes. Overridable so a second server can be run
   * against the same source without the two of them overwriting each other's
   * chunks — which is how a page can serve correct HTML and then fail to load
   * a single script. Unset, which is every normal run, it is the usual `.next`.
   */
  ...(process.env.NEXT_DIST_DIR ? { distDir: process.env.NEXT_DIST_DIR } : {}),
  // This project sits under a directory that has other lockfiles; pin the trace
  // root so Next does not infer a parent folder as the workspace.
  outputFileTracingRoot: import.meta.dirname,
  poweredByHeader: false,
  images: {
    /*
     * A quality has to be declared here or `quality={n}` on an <Image> is
     * quietly ignored and served at 75 anyway. The hero is the one that needs
     * it: a decorative photograph sitting at 70% opacity under a dark gradient,
     * where the detail a high quality buys is thrown away before anyone sees it.
     */
    qualities: [50, 75],
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          // Customers type a phone number and upload a payment screenshot here, so
          // once the site has been served over HTTPS the browser must never be
          // talked back down to HTTP. Only set in production: localhost is HTTP.
          ...(process.env.NODE_ENV === "production"
            ? [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" }]
            : []),
        ],
      },
      {
        // Payment screenshots must never be cached by shared caches.
        source: "/api/admin/:path*",
        headers: [{ key: "Cache-Control", value: "no-store, max-age=0" }],
      },
    ];
  },
};
export default nextConfig;
