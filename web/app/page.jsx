import { release } from './release';

export default function Home() {
  return (
    <main>
      <section className="hero">
        <nav className="nav" aria-label="Main">
          <a className="brand" href="/">
            <img src="/brand/backboard_logo.svg" alt="" />
            <span>Backboard Studio</span>
          </a>
          <a className="navLink" href="https://backboard.io">Backboard</a>
        </nav>

        <div className="heroGrid">
          <div className="copy">
            <p className="eyebrow">Public macOS download</p>
            <h1>Backboard Studio</h1>
            <p className="lede">
              A desktop coding workspace with Backboard agents built into the editor.
              Download the notarized macOS build for Apple Silicon.
            </p>

            <div className="actions" aria-label="Download actions">
              <a className="primaryButton" href={release.href} download>
                Download for Mac
              </a>
              <a className="secondaryButton" href="#release-details">
                Release details
              </a>
            </div>
          </div>

          <div className="productPanel" aria-label="Backboard Studio preview">
            <div className="windowChrome">
              <span />
              <span />
              <span />
            </div>
            <div className="editorMock">
              <aside>
                <div className="sideItem active">Agent Workspace</div>
                <div className="sideItem">Project</div>
                <div className="sideItem">Search</div>
                <div className="sideItem">Git</div>
              </aside>
              <section>
                <div className="appBadge">
                  <img src="/brand/app-icon.png" alt="" />
                  <div>
                    <strong>Backboard Studio</strong>
                    <span>{release.platform}</span>
                  </div>
                </div>
                <div className="agentCard">
                  <span>Agent</span>
                  <p>Ready to inspect, edit, and run code in your workspace.</p>
                </div>
                <div className="codeBlock">
                  <span>status</span>
                  <code>notarized: accepted</code>
                  <code>runtime: native-rust</code>
                  <code>artifact: dmg</code>
                </div>
              </section>
            </div>
          </div>
        </div>
      </section>

      <section id="release-details" className="details">
        <div className="detailsInner">
          <div>
            <p className="eyebrow">Current artifact</p>
            <h2>{release.platform}</h2>
            <p className="detailText">
              This DMG was signed with Developer ID, accepted by Apple notarization,
              and stapled before publishing.
            </p>
          </div>

          <dl className="facts">
            <div>
              <dt>File</dt>
              <dd>{release.filename}</dd>
            </div>
            <div>
              <dt>Size</dt>
              <dd>{release.size}</dd>
            </div>
            <div>
              <dt>Build</dt>
              <dd>{release.version}</dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>{release.notarization}</dd>
            </div>
            <div className="checksum">
              <dt>SHA-256</dt>
              <dd>{release.sha256}</dd>
            </div>
          </dl>
        </div>
      </section>
    </main>
  );
}
