"use client";

import { useEffect, useRef, useState } from "react";
import { RCliTerminal } from "@/components/RCliTerminal";
import { models } from "@/data/models";

const TILES = [
  "skiers",
  "sun",
  "lineup",
  "tennis",
  "reef",
  "shore",
  "wave",
  "afterglow",
  "solar",
  "walk",
  "drift",
  "vermilion",
  "first",
  "ribbon",
  "skiers2",
];

type Step = { n: string; title: string; cmd: string; text: string };
const STEPS: Record<string, Step> = {
  open: {
    n: "01",
    title: "Open a terminal",
    cmd: "cd ~/my-app",
    text: "Any terminal, any project folder. Nothing to configure first.",
  },
  run: {
    n: "02",
    title: "Run backboard",
    cmd: "backboard",
    text: "The same agent you get in Backboard Desktop starts right where you are.",
  },
  ask: {
    n: "03",
    title: "Ask for a change",
    cmd: "› add a dark mode toggle",
    text: "Say what you want in plain words. It reads the code it needs and makes the edits.",
  },
  review: {
    n: "04",
    title: "Review and keep going",
    cmd: "✓ 48 tests passed",
    text: "See every file it touched and the checks it ran, then ask for the next thing.",
  },
};

// Checkerboard, 7 columns × 6 rows: paintings on one parity; black squares,
// steps, the model count and the mini terminals on the other. The steps read
// in order around the live demo (01 02 above it, 03 04 below) and the bottom
// row breaks up checker-style. "." is empty page.
//   i:<tile> painting   k black   s:<step> numbered step   m models   t terminal
//   T is the live R-CLI demo, a 4×3 block (rows 2–4, columns 4–7).
const MAP = [
  [".", ".", "i:sun", "s:open", "i:lineup", "s:run", "i:reef"],
  ["k", "i:shore", "k", "T", "T", "T", "T"],
  ["i:wave", "m", "i:tennis", "T", "T", "T", "T"],
  ["k", "i:walk", "t", "T", "T", "T", "T"],
  ["i:skiers", "k", "i:afterglow", "s:ask", "i:solar", "s:review", "i:first"],
  [".", "i:drift", "t", ".", "k", ".", "k"],
];

type Cell = { key: string; r: number; c: number; kind: string; value: string };
const cells: Cell[] = MAP.flatMap((row, r) =>
  row.map((tok, c) => {
    const [kind, value = ""] = tok.split(":");
    return { key: `${r}-${c}`, r, c, kind, value };
  }),
).filter((c) => c.kind !== "." && c.kind !== "T");

export function CliGrid() {
  const initial = Object.fromEntries(
    cells.filter((c) => c.kind === "i").map((c) => [c.key, c.value]),
  );
  const [art, setArt] = useState<Record<string, string>>(initial);
  const [open, setOpen] = useState<Step | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);

  // Every couple of seconds one painting tile swaps for another.
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const id = window.setInterval(() => {
      if (document.hidden) return;
      setArt((cur) => {
        const keys = Object.keys(cur);
        const key = keys[Math.floor(Math.random() * keys.length)];
        const used = new Set(Object.values(cur));
        const free = TILES.filter((t) => !used.has(t));
        if (!free.length) return cur;
        return { ...cur, [key]: free[Math.floor(Math.random() * free.length)] };
      });
    }, 2200);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <>
      <div className="rg" aria-label="How Backboard CLI works">
        <div className="rg-demo">
          <RCliTerminal compact />
          {/* On phones the block is small: tap for the full-size session. */}
          <button
            type="button"
            className="rg-demo-open"
            onClick={() => setOpen(STEPS.run)}
          >
            Watch the session ↗
          </button>
        </div>
        {cells.map((cell, i) => {
          const style = {
            gridRow: cell.r + 1,
            gridColumn: cell.c + 1,
            "--i": i,
          } as React.CSSProperties;
          if (cell.kind === "i")
            return (
              <div
                key={cell.key}
                className="rg-cell rg-img"
                style={style}
                aria-hidden="true"
              >
                <Swap src={`/assets/tiles/${art[cell.key]}.webp`} />
              </div>
            );
          if (cell.kind === "k")
            return (
              <div
                key={cell.key}
                className="rg-cell rg-black"
                style={style}
                aria-hidden="true"
              />
            );
          if (cell.kind === "t")
            return (
              <button
                key={cell.key}
                type="button"
                className="rg-cell rg-term"
                style={style}
                onClick={() => setOpen(STEPS.run)}
                aria-label="See a CLI session"
              >
                <span>$ backboard</span>
                <span>› make it</span>
                <i />
              </button>
            );
          if (cell.kind === "m")
            return (
              <div
                key={cell.key}
                className="rg-cell rg-num rg-num--models"
                style={style}
              >
                <b>{models.length}</b>
                <span>model families</span>
              </div>
            );
          const step = STEPS[cell.value];
          return (
            <button
              key={cell.key}
              type="button"
              className="rg-cell rg-num"
              style={style}
              onClick={() => setOpen(step)}
            >
              <b>{step.n}</b>
              <span>{step.title}</span>
              <em>See it ↗</em>
            </button>
          );
        })}
      </div>

      <dialog
        ref={dialog}
        className="rp"
        onClose={() => setOpen(null)}
        onClick={(e) => e.target === dialog.current && setOpen(null)}
      >
        {open && (
          <div className="rp-inner">
            <button
              type="button"
              className="rp-close"
              onClick={() => setOpen(null)}
              aria-label="Close"
            >
              ×
            </button>
            <p className="rp-kicker">Step {open.n} of 04</p>
            <h2>{open.title}</h2>
            <p className="rp-pitch">{open.text}</p>
            <code className="rp-cmd">{open.cmd}</code>
            <div className="rp-demo">
              <RCliTerminal />
            </div>
            <nav className="rp-steps" aria-label="Steps">
              {Object.values(STEPS).map((s) => (
                <button
                  key={s.n}
                  type="button"
                  aria-current={s.n === open.n}
                  onClick={() => setOpen(s)}
                >
                  {s.n}
                </button>
              ))}
            </nav>
          </div>
        )}
      </dialog>
    </>
  );
}

// Crossfades to a new image whenever src changes.
function Swap({ src }: { src: string }) {
  const [layers, setLayers] = useState([src]);
  useEffect(() => {
    setLayers((l) => (l[l.length - 1] === src ? l : [l[l.length - 1], src]));
    const t = setTimeout(() => setLayers([src]), 900);
    return () => clearTimeout(t);
  }, [src]);
  return (
    <>
      {layers.map((s, i) => (
        <img
          key={s}
          src={s}
          alt=""
          className={
            i === layers.length - 1 && layers.length > 1 ? "is-new" : ""
          }
        />
      ))}
    </>
  );
}
