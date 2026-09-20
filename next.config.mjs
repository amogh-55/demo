/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // This project sits under a directory that has other lockfiles; pin the trace
  // root so Next does not infer a parent folder as the workspace.
  outputFileTracingRoot: import.meta.dirname,
  poweredByHeader: false,
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
