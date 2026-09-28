import type { Metadata } from "next";
import { SiteHeader } from "@/components/SiteHeader";
import { DownloadButtons } from "@/components/DownloadButtons";
import { WorkspaceDemo } from "@/components/WorkspaceDemo";
import { ModelSlider } from "@/components/ModelSlider";
import "./kevin.css";

export const metadata: Metadata = {
  title: "Kevin — Big idea. Meet Kevin.",
  description:
    "Kevin, the IDE by Backboard Studio. Your editor and AI agents, together.",
};

export default function KevinPage() {
  return (
    <>
      <a className="skip" href="#main">
        Skip to content
      </a>
      <SiteHeader />
      <main id="main">
        <section className="canvas-hero" aria-labelledby="hero-title">
          <div className="hero-copy">
            <h1 id="hero-title">
              Big idea.
              <br />
              Meet <em>Kevin.</em>
            </h1>
            <DownloadButtons />
            <img
              className="hero-lineup"
              src="/assets/kevin-surf-lineup.png"
              alt=""
              aria-hidden="true"
            />
          </div>
          <img
            className="hero-reef"
            src="/assets/kevin-reef-cove.png"
            alt=""
            aria-hidden="true"
          />
          <img
            className="hero-sun"
            src="/assets/sun-study-2026-09-27/08-painted-sun.png"
            alt=""
            aria-hidden="true"
          />
          <WorkspaceDemo />
          <img
            className="hero-surf"
            src="/assets/kevin-wave-ribbon.png"
            alt=""
            aria-hidden="true"
          />
          <img
            className="hero-foam"
            src="/assets/kevin-nav-foam.png"
            alt=""
            aria-hidden="true"
          />
          <ModelSlider />
        </section>
        <section
          className="perspective"
          id="perspective"
          aria-labelledby="perspective-title"
        >
          <img
            className="sunray-seam"
            src="/assets/sun-study-2026-09-27/09-sunray-sweep.png"
            alt=""
            aria-hidden="true"
            loading="lazy"
          />
          <img
            className="perspective-surf"
            src="/assets/kevin-wave-ribbon.png"
            alt=""
            aria-hidden="true"
            loading="lazy"
          />
          <div className="perspective-copy">
            <p className="eyebrow">A LITTLE LESS “ONE DAY”</p>
            <h2 id="perspective-title">
              It’s yours
              <br />
              to make.
            </h2>
            <p>
              A side project. A strange little experiment.
              <br />
              The app you wish existed.
              <br />
              Give it a place to start.
            </p>
            <a className="closing-link" href="#downloads">
              Start with Kevin <span>↗</span>
            </a>
          </div>
          <div className="closing-art">
            <img
              className="closing-postcard"
              src="/assets/motion-surf.jpeg"
              alt="A surfer against a streaked orange sunset"
              loading="lazy"
            />
            <img
              src="/assets/kevin-sunset-shore.png"
              alt="Surfers heading toward the water beneath a painted orange sun"
              loading="lazy"
            />
            <span>see you out there.</span>
          </div>
          <div className="afterglow" aria-hidden="true">
            <img
              src="/assets/sun-study-2026-09-27/07-afterglow.png"
              alt=""
              loading="lazy"
            />
          </div>
        </section>
        <footer>
          <a className="wordmark" href="#">
            kevin<span>.</span>
          </a>
          <p>
            An IDE by Backboard Studio.
            <br />
            Made for whatever you make next.
          </p>
          <a href="https://github.com/Backboard-io/Backboard-Desktop">
            Find us on GitHub ↗
          </a>
          <a href="#downloads">Get Kevin ↑</a>
        </footer>
      </main>
    </>
  );
}
