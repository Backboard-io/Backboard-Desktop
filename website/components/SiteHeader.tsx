export function SiteHeader({
  variant = "kevin",
}: {
  variant?: "kevin" | "hub";
}) {
  const hub = variant === "hub";
  return (
    <header className="site-header shared-header shared-header--ocean">
      <nav className="nav-left" aria-label="Product navigation">
        <a href={hub ? "/#products" : "/kevin#workspace"}>
          {hub ? "Products" : "Workspace"}
        </a>
        {!hub && <a href="/kevin#models">Models</a>}
        <a
          href={
            hub
              ? "https://docs.backboard.io"
              : "https://github.com/Backboard-io/Backboard-Desktop#documentation"
          }
        >
          Docs ↗
        </a>
      </nav>
      <a className="brand" href="/" aria-label="Backboard Studio home">
        <img src="/logo.svg" width="25" height="34" alt="" />
        <span>
          BACKBOARD
          <br />
          STUDIO
        </span>
      </a>
      <nav className="nav-right" aria-label="Community navigation">
        <a href="https://github.com/Backboard-io/Backboard-Desktop">GitHub ↗</a>
        <a href="/cloud/">Cloud ↗</a>
        <a className="header-cta" href={hub ? "/kevin" : "/kevin#downloads"}>
          {hub ? "Open Kevin ↗" : "Download ↗"}
        </a>
      </nav>
    </header>
  );
}
