import path from "node:path";
import type { NextConfig } from "next";

/**
 * The `/api/:path*` rewrite that used to live here is gone, deliberately.
 *
 * `rewrites()` is static configuration: it runs per request but cannot see the
 * session cookie, so it can never say who is asking. Since auth landed, every
 * `/api/*` request is rewritten upstream by `proxy.ts` instead, which does
 * know - and which attaches `X-User-Id` and `X-Proxy-Secret` on the way.
 *
 * Keeping the rewrite as a "fallback" would have been actively harmful: it is
 * the path a request takes when it slips past the proxy's matcher, and it
 * reaches FastAPI with no identity and no secret. One door is the point.
 * `/api/auth/*` is Auth.js's own route handler and never leaves this server.
 */
const nextConfig: NextConfig = {
  // Without this, Turbopack walks up past the repo and picks a lockfile in
  // the user's home directory.
  turbopack: { root: path.resolve(__dirname) },
};

export default nextConfig;
