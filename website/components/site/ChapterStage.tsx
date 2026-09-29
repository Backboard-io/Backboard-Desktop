"use client";

import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import "./chapter.css";

// The home page's app chapters on one pinned stage. Scroll holds each chapter
// for a beat, then a pixel wipe carries you to the next: navy pixels fill in
// over the current chapter in Bayer order, the chapters swap underneath at
// full cover, and the pixels clear to reveal the next one. The wipe is drawn
// on one small canvas, and its progress eases toward the scroll position every
// frame, so it glides even on chunky mouse-wheel steps.
// Phones, short windows and reduced motion get the chapters stacked normally.

const BAYER = [
  [0, 32, 8, 40, 2, 34, 10, 42],
  [48, 16, 56, 24, 50, 18, 58, 26],
  [12, 44, 4, 36, 14, 46, 6, 38],
  [60, 28, 52, 20, 62, 30, 54, 22],
  [3, 35, 11, 43, 1, 33, 9, 41],
  [51, 19, 59, 27, 49, 17, 57, 25],
  [15, 47, 7, 39, 13, 45, 5, 37],
  [63, 31, 55, 23, 61, 29, 53, 21],
];
const CELL = 18; // on-screen pixel size of the wipe
const SEG = 1.25; // scroll per chapter, in viewport heights
const HOLD = 0.4; // share of that spent holding still before the wipe
const EASE = 0.14; // how quickly the shown progress chases the scroll
const INK = "#1c1861";

export type StageChapter = {
  id: string;
  title: string;
  tag: string;
  node: ReactNode;
};

const smooth = (x: number) => x * x * (3 - 2 * x);

export function ChapterStage({ chapters }: { chapters: StageChapter[] }) {
  const track = useRef<HTMLDivElement>(null);
  const n = chapters.length;

  useEffect(() => {
    const el = track.current;
    if (!el) return;
    const layers = [...el.querySelectorAll<HTMLElement>(".stage-layer")];
    const anchors = [...el.querySelectorAll<HTMLElement>(".stage-anchor")];
    const canvas = el.querySelector<HTMLCanvasElement>(".stage-wipe");
    const tag = el.querySelector<HTMLElement>(".stage-tag");
    const ctx = canvas?.getContext("2d");
    const staged = window.matchMedia(
      "(min-width: 901px) and (min-height: 560px) and (prefers-reduced-motion: no-preference)",
    );
    // Stacked (not staged): each chapter plays its entrance when it scrolls in.
    const stack = new IntersectionObserver(
      (entries) =>
        entries.forEach((e) => {
          if (e.isIntersecting) {
            e.target.classList.add("is-in");
            stack.unobserve(e.target);
          }
        }),
      { threshold: 0.15 },
    );
    let raf = 0;
    let shown = 0; // progress in chapters, eased
    let visible = -1;
    let lastCover = -1;
    let w = 0;
    let h = 0;

    const target = () => {
      const seg = SEG * window.innerHeight;
      return Math.min(
        n - 1,
        Math.max(0, -el.getBoundingClientRect().top / seg),
      );
    };

    const show = (j: number) => {
      if (j === visible) return;
      visible = j;
      layers.forEach((l, k) => {
        const on = k === j;
        l.style.visibility = on ? "visible" : "hidden";
        l.style.pointerEvents = on ? "auto" : "none";
      });
    };

    const paint = (cover: number) => {
      if (!ctx || !canvas) return;
      const level = Math.round(cover * 64);
      if (level === lastCover) return;
      lastCover = level;
      ctx.clearRect(0, 0, w, h);
      if (level <= 0) return;
      ctx.fillStyle = INK;
      const cols = Math.ceil(w / CELL);
      const rows = Math.ceil(h / CELL);
      for (let r = 0; r < rows; r++) {
        const b = BAYER[r % 8];
        for (let c = 0; c < cols; c++)
          if (b[c % 8] < level) ctx.fillRect(c * CELL, r * CELL, CELL, CELL);
      }
    };

    const frame = () => {
      raf = 0;
      if (!staged.matches) return;
      const goal = target();
      shown += (goal - shown) * EASE;
      if (Math.abs(goal - shown) < 0.0005) shown = goal;

      const i = Math.min(n - 1, Math.floor(shown));
      const f = shown - i;
      const t =
        i >= n - 1
          ? 0
          : smooth(Math.min(1, Math.max(0, (f - HOLD) / (1 - HOLD))));
      // First half: pixels cover chapter i. Second half: they clear off i+1.
      show(t < 0.5 ? i : i + 1);
      // Play the shown chapter's entrance once the stage has scrolled into view.
      if (el.getBoundingClientRect().top < window.innerHeight * 0.4) layers[visible]?.classList.add("is-in");
      paint(smooth(t < 0.5 ? t * 2 : (1 - t) * 2));

      if (tag) {
        const next = chapters[i + 1];
        tag.style.opacity = next ? String(Math.sin(Math.PI * t)) : "0";
        if (next)
          tag.textContent = `${String(i + 2).padStart(2, "0")} / ${String(n).padStart(2, "0")} · ${next.title}`;
      }
      if (shown !== goal) raf = requestAnimationFrame(frame);
    };

    const kick = () => {
      if (!raf) raf = requestAnimationFrame(frame);
    };

    const layout = () => {
      const vh = window.innerHeight;
      const header =
        parseFloat(
          getComputedStyle(document.documentElement).getPropertyValue(
            "--site-header-h",
          ),
        ) || 0;
      if (staged.matches) {
        el.classList.add("is-staged");
        el.style.height = `${(n - 1 + HOLD) * SEG * vh + vh}px`;
        anchors.forEach(
          (a, i) => (a.style.top = `${i * SEG * vh + header + 0.1 * vh}px`),
        );
        if (canvas && ctx) {
          const dpr = Math.min(2, window.devicePixelRatio || 1);
          w = canvas.clientWidth;
          h = canvas.clientHeight;
          canvas.width = Math.round(w * dpr);
          canvas.height = Math.round(h * dpr);
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        }
        shown = target();
        visible = -1;
        lastCover = -1;
        kick();
      } else {
        el.classList.remove("is-staged");
        el.style.height = "";
        layers.forEach((l) => {
          l.style.visibility = l.style.pointerEvents = "";
          stack.observe(l);
        });
        anchors.forEach((a, i) => (a.style.top = `${layers[i].offsetTop}px`));
      }
    };

    layout();
    window.addEventListener("scroll", kick, { passive: true });
    window.addEventListener("resize", layout);
    staged.addEventListener("change", layout);
    return () => {
      window.removeEventListener("scroll", kick);
      window.removeEventListener("resize", layout);
      staged.removeEventListener("change", layout);
      cancelAnimationFrame(raf);
      stack.disconnect();
    };
  }, [chapters, n]);

  return (
    <div className="stage-track" ref={track}>
      {chapters.map((c) => (
        <span
          key={c.id}
          id={c.id}
          className="stage-anchor"
          data-chapter={c.id}
          aria-hidden="true"
        />
      ))}
      <div className="stage">
        {chapters.map((c) => (
          <section
            key={c.id}
            className={`stage-layer chapter is-${c.id}`}
            aria-label={c.title}
          >
            {c.node}
          </section>
        ))}
        <canvas className="stage-wipe" aria-hidden="true" />
        <span className="stage-tag" aria-hidden="true" />
      </div>
    </div>
  );
}
