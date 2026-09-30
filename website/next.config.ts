import type { NextConfig } from "next";

const config: NextConfig = {
  devIndicators: false,
  async redirects() {
    return [
      // Old concept URLs.
      {
        source: "/kevin-concept.html",
        destination: "/desktop",
        permanent: true,
      },
      { source: "/kevin/:path*", destination: "/desktop", permanent: true },
      { source: "/index.html", destination: "/", permanent: true },
      // Friendly aliases, including backboard.io's /products/* paths.
      { source: "/products/desktop", destination: "/desktop", permanent: true },
      { source: "/products/cli", destination: "/cli", permanent: true },
      { source: "/products/r-cli", destination: "/cli", permanent: true },
      { source: "/products/nash", destination: "/nash", permanent: true },
      { source: "/ide", destination: "/desktop", permanent: true },
      { source: "/r-cli", destination: "/cli", permanent: true },
      {
        source: "/download",
        destination: "/desktop#download",
        permanent: false,
      },
      {
        source: "/downloads",
        destination: "/desktop#download",
        permanent: false,
      },
      { source: "/install", destination: "/cli#install", permanent: false },
      {
        source: "/docs",
        destination: "https://docs.backboard.io/",
        permanent: false,
      },
      {
        source: "/github",
        destination: "https://github.com/Backboard-io",
        permanent: false,
      },
    ];
  },
  async rewrites() {
    return [{ source: "/cloud", destination: "/cloud/index.html" }];
  },
};

export default config;
