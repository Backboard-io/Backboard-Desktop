import { CliGrid } from "@/components/CliGrid";
import { InstallCommands } from "@/components/InstallCommands";
import { GithubLink } from "@/components/GithubLink";
import { CLI_REPO_URL } from "@/data/links";
import "@/components/demos.css";
import "./cli.css";

const REPO = CLI_REPO_URL;

// The Backboard CLI one-pager, alone at /cli or embedded in the Studio home.
export function CliScreen({ embedded = false }: { embedded?: boolean }) {
  const Title = embedded ? "h2" : "h1";
  return (
    <div className={`ro${embedded ? " is-embedded" : " is-page"}`}>
      <div className="ro-main">
        <section className="ro-copy" aria-labelledby="ro-title">
          <Title id="ro-title" className="ro-title">
            <span>Type it.</span>
            <span>Watch it.</span>
            <span>Ship it</span>
            <em>(from the terminal).</em>
          </Title>
          <p className="ro-sub">
            The Backboard agent right where you already work. Ask for a change
            and watch it read, edit and test your code. Open source, and it runs
            any model you like.
          </p>
          <div id="install" className="ro-install">
            <InstallCommands />
            <GithubLink href={CLI_REPO_URL} label="Backboard CLI" />
          </div>
        </section>

        <CliGrid />
      </div>

      <footer className="ro-foot">
        <a href="/">← Backboard Studio</a>
        <span aria-hidden="true">•</span>
        <a href="/desktop">Desktop</a>
        <span aria-hidden="true">•</span>
        <a href="/nash">Nash</a>
        <span aria-hidden="true">•</span>
        <a href={REPO}>GitHub</a>
      </footer>
    </div>
  );
}
