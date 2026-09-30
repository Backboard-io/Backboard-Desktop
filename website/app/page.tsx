import type { Metadata } from "next";
import type { ReactNode } from "react";
import { HeroFilm } from "@/components/HeroFilm";
import { CliScreen } from "@/components/screens/CliScreen";
import { DesktopScreen } from "@/components/screens/DesktopScreen";
import { NashScreen } from "@/components/screens/NashScreen";
import { SoonScreen } from "@/components/screens/SoonScreen";
import { ChapterStage } from "@/components/site/ChapterStage";
import { StudioMark } from "@/components/StudioMark";
import { DOCS, REPO } from "@/data/links";
import "./hub.css";

export const metadata: Metadata = {
  title: "Backboard Studio",
  description: "Home of Backboard Desktop, Backboard CLI, Nash and more.",
};

// Each chapter is the app's own one-pager, exactly as it appears on its page.
const CHAPTERS: {
  id: string;
  title: string;
  tag: string;
  screen: ReactNode;
}[] = [
  {
    id: "desktop",
    title: "Backboard Desktop",
    tag: "IDE",
    screen: <DesktopScreen embedded />,
  },
  {
    id: "cli",
    title: "Backboard CLI",
    tag: "Terminal",
    screen: <CliScreen embedded />,
  },
  {
    id: "nash",
    title: "Nash",
    tag: "New",
    screen: <NashScreen embedded />,
  },
  {
    id: "giggsfields",
    title: "Giggsfields",
    tag: "Coming soon",
    screen: (
      <SoonScreen
        embedded
        id="giggsfields"
        name="Giggsfields"
        line="A canvas for images and video, driven by the models you already use in Backboard."
        art="/assets/pixel/giggsfields-color.webp"
      />
    ),
  },
  {
    id: "apps",
    title: "Backboard Apps",
    tag: "Coming soon",
    screen: (
      <SoonScreen
        embedded
        id="apps"
        name="Backboard Apps"
        line="Take what you made in Backboard and put it out into the world, running anywhere."
        art="/assets/pixel/apps-color.webp"
      />
    ),
  },
];

const PAPER = "#f6f1e7";

export default function StudioHub() {
  return (
    <div className="nw" id="top">
      <main>
        <section
          className="nw-hero"
          data-chapter="home"
          aria-labelledby="nw-title"
        >
          <p className="nw-kicker">Desktop • CLI • Nash • More soon</p>
          <h1 id="nw-title">
            <span>Backboard</span> <span>Studio</span>
          </h1>
          <HeroFilm className="nw-film" />
        </section>

        <ChapterStage
          chapters={CHAPTERS.map(({ id, title, tag, screen }) => ({
            id,
            title,
            tag,
            node: screen,
          }))}
        />

        <section className="nw-signoff" aria-label="Sign-off">
          <p>Apps for people</p>
          <p>with big ideas.</p>
        </section>
      </main>

      <footer className="nw-foot">
        <div className="nw-foot-brand">
          <StudioMark size={42} />
          <b>Backboard Studio</b>
          <span>Apps for people with big ideas.</span>
        </div>
        <nav aria-label="Apps">
          <b>Apps</b>
          <a href="/desktop">Backboard Desktop</a>
          <a href="/cli">Backboard CLI</a>
          <a href="/nash">Nash</a>
          <span>Giggsfields · soon</span>
          <span>Backboard Apps · soon</span>
        </nav>
        <nav aria-label="Studio">
          <b>Studio</b>
          <a href={REPO}>GitHub ↗</a>
          <a href={DOCS}>Docs ↗</a>
          <a href="/cloud/">Cloud</a>
        </nav>
        <p className="nw-foot-legal">© 2026 Backboard Studio</p>
      </footer>
    </div>
  );
}
