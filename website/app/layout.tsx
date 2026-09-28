import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
export const metadata: Metadata = {
  title: "Backboard Studio",
  description:
    "Kevin, CLI, Nash, Backboard Canvas, and Backboard Apps. Choose your space.",
  icons: { icon: "/logo.svg" },
};
export const viewport: Viewport = { themeColor: "#e5f4e9" };
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
