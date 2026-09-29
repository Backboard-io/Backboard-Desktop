import { BackboardIde } from "@/components/ide/BackboardIde";
import { ModelMarquee } from "@/components/ModelMarquee";
import { TrustedBy } from "@/components/TrustedBy";
import { DownloadButton } from "./DownloadButton";
import "./desktop.css";

// The Backboard Desktop one-pager. Rendered alone at /desktop ("is-page" owns
// the viewport) and as a chapter of the Studio home page ("embedded").
export function DesktopScreen({ embedded = false }: { embedded?: boolean }) {
  const Title = embedded ? "h2" : "h1";
  return (
    <div className={`dk${embedded ? " is-embedded" : " is-page"}`}>
      <div className="dk-art" aria-hidden="true">
        <span className="dk-piece is-sun">
          <img src="/assets/surf/sun.webp" alt="" />
        </span>
        <span className="dk-piece is-reef">
          <img src="/assets/surf/reef-cove.webp" alt="" />
        </span>
        <span className="dk-piece is-foam">
          <img src="/assets/surf/foam.webp" alt="" />
        </span>
        <span className="dk-piece is-lineup">
          <img src="/assets/surf/surf-lineup.webp" alt="" />
        </span>
        <span className="dk-piece is-shore">
          <img src="/assets/surf/sunset-shore.webp" alt="" />
        </span>
      </div>

      <main className="dk-main">
        <section className="dk-copy" aria-labelledby="dk-title">
          <div className="dk-head">
            <Title id="dk-title" className="dk-title">
              <span>Backboard</span> <span>Desktop</span>
            </Title>
            <img
              className="dk-app-icon"
              src="/assets/app-icon.png"
              alt=""
              width={64}
              height={64}
            />
          </div>

          <DownloadButton />

          <TrustedBy className="dk-trusted" />
        </section>

        <div className="dk-demo">
          <div className="dk-frame">
            <p className="dk-hint" aria-hidden="true">
              it&rsquo;s live, click around
              <svg viewBox="0 0 60 40">
                <path d="M4 6c18 2 34 10 44 26m0 0 1-11m-1 11-10-4" />
              </svg>
            </p>
            <BackboardIde className="dk-ide" />
            <span className="dk-piece is-ribbon" aria-hidden="true">
              <img src="/assets/surf/wave-ribbon.webp" alt="" />
            </span>
          </div>
        </div>
      </main>

      <ModelMarquee className="dk-marquee" />
    </div>
  );
}
