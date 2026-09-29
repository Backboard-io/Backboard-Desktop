import { RisoSun } from "@/components/RisoSun";
import { GithubLink } from "@/components/GithubLink";
import { TourVideo } from "@/components/TourVideo";
import { NASH_REPO } from "@/data/links";
import "./nash.css";

export const NASH = "https://hellonash.ai";

// The Nash one-pager, alone at /nash or embedded in the Studio home.
export function NashScreen({ embedded = false }: { embedded?: boolean }) {
  const Title = embedded ? "h2" : "h1";
  return (
    <div className={`ns${embedded ? " is-embedded" : " is-page"}`}>
      <div className="ns-main">
        <section className="ns-hero" aria-labelledby="ns-title">
          <RisoSun />
          <div className="ns-hero-copy">
            <p className="ns-kicker">
              <span>New</span>
              <span>From Backboard Studio</span>
            </p>
            <Title id="ns-title" className="ns-title">
              Nash
            </Title>
            <div className="ns-cta">
              <a className="ns-btn" href={NASH}>
                Say hello to Nash ↗
              </a>
              <span className="ns-url">hellonash.ai</span>
              <GithubLink href={NASH_REPO} label="Nash" />
            </div>
          </div>
          <div className="ns-tour">
            <TourVideo />
          </div>
        </section>
      </div>

      <footer className="ns-foot">
        <a href="/">← Backboard Studio</a>
        <a href={NASH}>hellonash.ai ↗</a>
      </footer>
    </div>
  );
}
