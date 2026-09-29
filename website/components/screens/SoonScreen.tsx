import "./soon.css";

// One-pager for an app that isn't out yet: giant name, one line, and its
// painting, which keeps drifting between pixel art and full colour.
export function SoonScreen({
  id,
  name,
  line,
  art,
  embedded = false,
}: {
  id: string;
  name: string;
  line: string;
  /** Painting to show in colour; its pixel twin comes from /assets/pixel/{id}.png. */
  art: string;
  embedded?: boolean;
}) {
  const Title = embedded ? "h2" : "h1";
  return (
    <div className={`soon is-${id}${embedded ? " is-embedded" : " is-page"}`}>
      <div className="soon-copy">
        <p className="soon-kicker">
          <span>Coming soon</span>
          <span>Backboard Studio</span>
        </p>
        <Title className="soon-title">{name}</Title>
        <p className="soon-line">{line}</p>
        <a className="soon-btn" href="https://github.com/Backboard-io">
          Follow along on GitHub ↗
        </a>
      </div>
      <div className="soon-art" aria-hidden="true">
        <div className="soon-plate">
          <img className="soon-pixel" src={`/assets/pixel/${id}.png`} alt="" />
          <img className="soon-color" src={art} alt="" loading="lazy" />
        </div>
      </div>
    </div>
  );
}
