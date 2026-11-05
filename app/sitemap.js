import { getBasePath } from "@/lib/base-path";

/** Prefer public origin from env; fall back for local/dev. */
function getSiteOrigin() {
  const candidates = [
    process.env.NEXT_PUBLIC_SITE_URL,
    process.env.NEXT_PUBLIC_BASE_URL,
  ].filter(Boolean);

  for (const raw of candidates) {
    try {
      return new URL(raw).origin;
    } catch {
      /* ignore invalid URL */
    }
  }

  return "http://localhost:3000";
}

function absoluteUrl(pathname = "/") {
  const origin = getSiteOrigin();
  const base = getBasePath();
  const path = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return `${origin}${base}${path === "/" ? "" : path}` || `${origin}${base}/`;
}

/** App routes exposed in the sitemap (JS App Router sitemap). */
const ROUTES = [
  { path: "/signin", changeFrequency: "monthly", priority: 1 },
  { path: "/dashboard", changeFrequency: "daily", priority: 0.9 },
  { path: "/purchase-orders", changeFrequency: "daily", priority: 0.8 },
  { path: "/incoming-po", changeFrequency: "daily", priority: 0.8 },
  { path: "/suppliers", changeFrequency: "weekly", priority: 0.7 },
  { path: "/replenishment", changeFrequency: "daily", priority: 0.8 },
  { path: "/packing-list", changeFrequency: "daily", priority: 0.7 },
  { path: "/forecast-generator", changeFrequency: "daily", priority: 0.8 },
  { path: "/sales", changeFrequency: "daily", priority: 0.7 },
  { path: "/stock-items", changeFrequency: "weekly", priority: 0.7 },
  { path: "/syncing", changeFrequency: "weekly", priority: 0.5 },
];

export default function sitemap() {
  const lastModified = new Date();

  return ROUTES.map(({ path, changeFrequency, priority }) => ({
    url: absoluteUrl(path),
    lastModified,
    changeFrequency,
    priority,
  }));
}
