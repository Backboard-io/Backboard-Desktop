import type { Metadata } from "next";
import { NashScreen } from "@/components/screens/NashScreen";

export const metadata: Metadata = {
  title: "Nash | From Backboard Studio",
  description: "Say hello to Nash, from Backboard Studio.",
};

export default function NashPage() {
  return <NashScreen />;
}
