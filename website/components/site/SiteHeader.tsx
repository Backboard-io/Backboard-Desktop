"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { StudioMark } from "@/components/StudioMark";
import { NASH_URL, REPO } from "@/data/links";
import "./site-header.css";

// One header for every page: the Studio mark home on the left, the apps in
// the middle (always real links to their pages), GitHub and one call to action
// on the right. Phones get the apps in a menu.

const APPS = [
  { label: "Desktop", href: "/desktop" },
  { label: "CLI", href: "/cli" },
  { label: "Nash", href: "/nash" },
];

function ctaFor(pathname: string): { label: string; href: string } {
  if (pathname.startsWith("/desktop"))
    return { label: "Download", href: "#download" };
  if (pathname.startsWith("/cli"))
    return { label: "Install", href: "#install" };
  if (pathname.startsWith("/nash"))
    return { label: "Say hello ↗", href: NASH_URL };
  return { label: "Get Desktop", href: "/desktop" };
}

export function SiteHeader() {
  const pathname = usePathname() ?? "/";
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const root = useRef<HTMLElement>(null);
  const cta = ctaFor(pathname);

  useEffect(() => setOpen(false), [pathname]);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    const onDown = (e: PointerEvent) => {
      if (root.current && !root.current.contains(e.target as Node))
        setOpen(false);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown);
    };
  }, []);

  return (
    <>
      <div className="sh-frame" aria-hidden="true" />
      <header
        className={`sh${scrolled ? " is-scrolled" : ""}${open ? " is-open" : ""}`}
        ref={root}
      >
        <a className="sh-brand" href="/" aria-label="Backboard Studio home">
          <StudioMark size={24} />
          <span>Backboard Studio</span>
        </a>

        <nav className="sh-apps" aria-label="Apps">
          {APPS.map((a) => (
            <a
              key={a.href}
              href={a.href}
              aria-current={pathname.startsWith(a.href) ? "page" : undefined}
            >
              {a.label}
            </a>
          ))}
        </nav>

        <div className="sh-right">
          <a
            className="sh-gh"
            href={REPO}
            aria-label="Backboard Studio on GitHub"
            title="GitHub"
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
            </svg>
          </a>
          <a className="sh-cta" href={cta.href}>
            {cta.label}
          </a>
          <button
            type="button"
            className="sh-burger"
            aria-expanded={open}
            aria-controls="sh-menu"
            aria-label={open ? "Close menu" : "Open menu"}
            onClick={() => setOpen((v) => !v)}
          >
            <span />
          </button>
        </div>

        {open && (
          <nav id="sh-menu" className="sh-menu" aria-label="Menu">
            <a href="/">Backboard Studio</a>
            {APPS.map((a) => (
              <a
                key={a.href}
                href={a.href}
                aria-current={pathname.startsWith(a.href) ? "page" : undefined}
              >
                {a.label}
              </a>
            ))}
            <a href={REPO}>GitHub ↗</a>
          </nav>
        )}
      </header>
    </>
  );
}
