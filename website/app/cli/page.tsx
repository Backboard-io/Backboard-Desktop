import type { Metadata } from "next";
import { CliScreen } from "@/components/screens/CliScreen";

export const metadata: Metadata = {
  title: "Backboard CLI | From the terminal",
  description: "The Backboard agent in the terminal you already live in. Part of Backboard Studio.",
};

export default function CliPage() {
  return <CliScreen />;
}
