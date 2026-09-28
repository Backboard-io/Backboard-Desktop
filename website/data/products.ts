export type Product = {
  id: string;
  name: string;
  href: string | null;
  action: string;
  artwork: string;
};

// Keep product destinations here so the launchpad has one source of truth.
export const products: Product[] = [
  {
    id: "kevin",
    name: "Kevin",
    href: "/kevin",
    action: "Open the IDE",
    artwork: "/assets/kevin-wave-paint.png",
  },
  {
    id: "cli",
    name: "CLI",
    href: "https://docs.backboard.io/cli/overview",
    action: "Get the CLI",
    artwork: "/assets/kevin-surf-lineup.png",
  },
  {
    id: "nash",
    name: "Nash",
    href: null,
    action: "Coming soon",
    artwork: "/assets/sun-study-2026-09-27/08-painted-sun.png",
  },
  {
    id: "canvas",
    name: "Backboard Canvas",
    href: null,
    action: "Coming soon",
    artwork: "/assets/kevin-reef-cove.png",
  },
  {
    id: "apps",
    name: "Backboard Apps",
    href: null,
    action: "Coming soon",
    artwork: "/assets/kevin-sunset-shore.png",
  },
];
