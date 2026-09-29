import type { Metadata } from "next";
import { DesktopScreen } from "@/components/screens/DesktopScreen";

export const metadata: Metadata = {
  title: "Backboard Desktop",
  description: "Your editor and your AI agents in one window. Part of Backboard Studio.",
  icons: { icon: "/logo.svg" },
};

export default function DesktopPage() {
  return <DesktopScreen />;
}
