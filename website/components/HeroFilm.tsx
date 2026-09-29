"use client";

import { useEffect, useRef, useState } from "react";

// The Studio film in the home hero: plays muted on a loop while on screen
// (browsers only autoplay muted), with a tiny sound toggle in the corner.
export function HeroFilm({ className = "" }: { className?: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [muted, setMuted] = useState(true);

  useEffect(() => {
    const v = ref.current;
    if (!v || window.matchMedia("(prefers-reduced-motion: reduce)").matches)
      return;
    const io = new IntersectionObserver(
      ([e]) => (e.isIntersecting ? v.play().catch(() => {}) : v.pause()),
      {
        threshold: 0.25,
      },
    );
    io.observe(v);
    return () => io.disconnect();
  }, []);

  const toggle = () => {
    const v = ref.current;
    if (!v) return;
    v.muted = !v.muted;
    setMuted(v.muted);
    if (!v.muted) v.play().catch(() => {});
  };

  return (
    <figure className={`hf ${className}`}>
      <video
        ref={ref}
        src="/assets/film/studio-build.mp4"
        poster="/assets/film/studio-build-poster.jpg"
        muted
        loop
        playsInline
        preload="auto"
        aria-label="Backboard Studio: build with agents"
      />
      <button
        type="button"
        className="hf-sound"
        onClick={toggle}
        aria-pressed={!muted}
        aria-label={muted ? "Turn sound on" : "Turn sound off"}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" />
          {muted ? (
            <path d="M16 9.5l5 5m0-5l-5 5" />
          ) : (
            <path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" />
          )}
        </svg>
      </button>
    </figure>
  );
}
