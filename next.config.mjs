/** @type {import('next').NextConfig} */
const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "";

const nextConfig = {
  basePath,

  // Staged CI builds use NEXT_DIST_DIR=.next-incoming. Dev uses .next-dev so
  // `next dev` never locks the live production `.next` folder (which breaks activate).
  distDir:
    process.env.NEXT_DIST_DIR ||
    (process.env.NODE_ENV === "production" ? ".next" : ".next-dev"),

  // mysql2 uses native Node.js modules — must not be bundled by Next.js
  serverExternalPackages: ["mysql2", "@supabase/supabase-js"],

  // Standalone output for Windows PM2 production deploy
  output: "standalone",

  // Built-in gzip compression for SSR responses (fallback when Nginx is absent)
  compress: true,

  // Remove the X-Powered-By header to reduce response size + hide stack
  poweredByHeader: false,

  // instrumentation → keep-alive → system-auth may be analyzed in the client
  // graph; Node builtins must not break the browser bundle.
  webpack: (config, { isServer }) => {
    if (!isServer) {
      config.resolve.fallback = {
        ...(config.resolve.fallback || {}),
        fs: false,
        path: false,
        os: false,
        net: false,
        tls: false,
        child_process: false,
      };
    }
    return config;
  },

  // Aggressive asset caching headers — Nginx will also set these for static files.
  // Skip Cache-Control on /_next/static in development — it breaks Next.js HMR/dev caching.
  async headers() {
    const security = {
      source: "/(.*)",
      headers: [
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "X-Frame-Options", value: "SAMEORIGIN" },
        { key: "X-XSS-Protection", value: "1; mode=block" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      ],
    };

    if (process.env.NODE_ENV !== "production") {
      return [security];
    }

    return [
      {
        // Immutable JS/CSS chunks — content-hashed, safe to cache forever
        source: "/_next/static/:path*",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=31536000, immutable",
          },
        ],
      },
      {
        // Public folder assets (fonts, images, icons)
        source: "/:path*.:ext(ico|png|jpg|jpeg|gif|svg|webp|woff|woff2|ttf|otf|eot)",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=86400, stale-while-revalidate=604800",
          },
        ],
      },
      {
        // Sign-in HTML must not be cached across deploys
        source: "/signin",
        headers: [
          {
            key: "Cache-Control",
            value: "no-store, must-revalidate",
          },
        ],
      },
      security,
    ];
  },
};

export default nextConfig;
