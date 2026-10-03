import { initAnalytics, trackPageview } from "@/lib/analytics";

// Runs before hydration. Stays cheap: with no analytics env vars set it only
// reads ad click ids off the URL.
try {
  initAnalytics();
} catch {
  // Analytics must never take the page down.
}

export function onRouterTransitionStart(url: string) {
  trackPageview(new URL(url, location.origin).toString());
}
