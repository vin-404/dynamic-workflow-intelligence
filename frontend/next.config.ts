import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async rewrites() {
    // API_REWRITE_URL is for server-side rewrites (Docker: http://api:8000)
    // Falls back to NEXT_PUBLIC_API_URL (client-side) or localhost default
    const apiUrl =
      process.env.API_REWRITE_URL ||
      process.env.NEXT_PUBLIC_API_URL ||
      "http://localhost:8001";
    return [
      {
        source: "/api/:path*",
        destination: `${apiUrl}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
