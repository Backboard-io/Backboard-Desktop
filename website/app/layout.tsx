import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { SiteHeader } from "@/components/site/SiteHeader";

export const metadata: Metadata = {
  title: "Backboard Studio",
  description:
    "Backboard Desktop, Backboard CLI, Nash, Giggsfields and Backboard Apps.",
  icons: { icon: "/studio.svg" },
};
export const viewport: Viewport = { themeColor: "#f6f1e7" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <SiteHeader />
        {children}
      </body>
    </html>
  );
}
