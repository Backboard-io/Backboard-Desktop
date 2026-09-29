import type { NextConfig } from "next";
const config: NextConfig = {
  devIndicators: false,
  async redirects() {
    return [
      { source: "/kevin-concept.html", destination: "/desktop", permanent: true },
      { source: "/kevin", destination: "/desktop", permanent: true },
      { source: "/index.html", destination: "/", permanent: true },
    ];
  },
  async rewrites() {
    return [{ source: "/cloud", destination: "/cloud/index.html" }];
  },
};
export default config;
