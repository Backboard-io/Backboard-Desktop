export type Product = {
  id: string;
  name: string;
  tag: string;
  /** One line, used in the index strip and footer. */
  blurb: string;
  /** A short paragraph for the product's section. */
  pitch: string;
  points: string[];
  /** The product's page on this site; null means Coming soon. */
  href: string | null;
  action: string;
  artwork: string;
};

// Every app Backboard Studio hosts, in the order the hub lists them.
export const products: Product[] = [
  {
    id: "desktop",
    name: "Backboard Desktop",
    tag: "IDE",
    blurb: "Your editor and your AI agents in one window.",
    pitch:
      "A full editor with agents built in. Describe what you want and watch it get built, or take the wheel whenever you like.",
    points: [
      "Simple: describe it, see it built",
      "Editor: your hands on the code",
      "Advanced: run a crew of agents at once",
    ],
    href: "/desktop",
    action: "Open Desktop",
    artwork: "/assets/kevin-wave-paint.png",
  },
  {
    id: "cli",
    name: "Backboard CLI",
    tag: "Terminal",
    blurb: "The same agent, straight from your terminal.",
    pitch:
      "The Backboard agent in the terminal you already live in. Ask for a change, watch it read, edit and test your code.",
    points: ["Same agents and models as Desktop", "Reads, edits and runs your code", "Works in any terminal"],
    href: "/cli",
    action: "Open CLI",
    artwork: "/assets/kevin-surf-lineup.png",
  },
  {
    id: "nash",
    name: "Nash",
    tag: "New",
    blurb: "Say hello to Nash.",
    pitch: "We're building something new for the family. We'll say more when it's ready.",
    points: [],
    href: "/nash",
    action: "Meet Nash",
    artwork: "/assets/sun-study-2026-09-27/07-afterglow.png",
  },
  {
    id: "giggsfields",
    name: "Giggsfields",
    tag: "Canvas",
    blurb: "A canvas for images and video.",
    pitch: "A canvas for making images and video, driven by the same models you already use in Backboard.",
    points: [],
    href: null,
    action: "Coming soon",
    artwork: "/assets/kevin-reef-cove.png",
  },
  {
    id: "apps",
    name: "Backboard Apps",
    tag: "Ship",
    blurb: "Ship what you build.",
    pitch: "Take what you made in Backboard and put it out into the world, running anywhere.",
    points: [],
    href: null,
    action: "Coming soon",
    artwork: "/assets/kevin-sunset-shore.png",
  },
];
