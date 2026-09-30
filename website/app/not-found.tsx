import type { Metadata } from "next";
import "./not-found.css";

export const metadata: Metadata = { title: "Not found | Backboard Studio" };

// Friendly 404 in the Studio style, with a way to every app.
export default function NotFound() {
  return (
    <main className="nf">
      <p className="nf-kicker">404 · Page not found</p>
      <h1>Wiped out.</h1>
      <p className="nf-line">
        That page isn&rsquo;t here. Paddle back to one of these:
      </p>
      <nav className="nf-links" aria-label="Pages">
        <a href="/">Backboard Studio</a>
        <a href="/desktop">Desktop</a>
        <a href="/cli">CLI</a>
        <a href="/nash">Nash</a>
      </nav>
    </main>
  );
}
