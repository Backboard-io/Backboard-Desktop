"use client";

import { useEffect, useRef, useState } from "react";
import { createImpasto, PAINTS, type RGB } from "@/lib/impasto";

const swatches: { name: string; key: keyof typeof PAINTS }[] = [
  { name: "Turquoise", key: "turquoise" },
  { name: "Ocean", key: "ocean" },
  { name: "Foam", key: "foam" },
  { name: "Sand", key: "sand" },
  { name: "Sun", key: "sun" },
  { name: "Pink", key: "pink" },
];

const css = (c: RGB) => `rgb(${c[0]} ${c[1]} ${c[2]})`;

// The hero's living impasto canvas. It paints a beach by itself; visitors can
// drag to add their own strokes, and tiny people ride whatever gets painted.
export function PaintCanvas() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const overlay = useRef<HTMLCanvasElement>(null);
  const engine = useRef<ReturnType<typeof createImpasto> | null>(null);
  const [active, setActive] = useState<keyof typeof PAINTS>("turquoise");

  useEffect(() => {
    const c = canvas.current!;
    const o = overlay.current!;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const e = createImpasto(c, o, { reduced });
    engine.current = e;

    let visible = true;
    const sync = () => (visible && !document.hidden ? e.start() : e.stop());
    const io = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      sync();
    });
    io.observe(c);
    document.addEventListener("visibilitychange", sync);

    let width = e.width();
    let t = 0;
    const onResize = () => {
      clearTimeout(t);
      t = window.setTimeout(() => {
        const w = c.getBoundingClientRect().width;
        if (Math.abs(w - width) > 40) {
          width = w;
          e.repaint();
        }
      }, 250);
    };
    window.addEventListener("resize", onResize);
    sync();

    return () => {
      io.disconnect();
      document.removeEventListener("visibilitychange", sync);
      window.removeEventListener("resize", onResize);
      clearTimeout(t);
      e.destroy();
    };
  }, []);

  return (
    <div className="pc">
      <canvas ref={canvas} className="pc-paint" aria-label="Live painting of a beach. Drag to paint your own strokes." role="img" />
      <canvas ref={overlay} className="pc-figures" aria-hidden="true" />
      <div className="pc-tools" role="toolbar" aria-label="Paint">
        <span className="pc-tools-label">Paint your own tracks</span>
        {swatches.map((s) => (
          <button
            key={s.key}
            type="button"
            className="pc-swatch"
            aria-label={s.name}
            aria-pressed={active === s.key}
            style={{ background: css(PAINTS[s.key]) }}
            onClick={() => {
              setActive(s.key);
              engine.current?.setColor(PAINTS[s.key]);
            }}
          />
        ))}
        <button type="button" className="pc-reset" onClick={() => engine.current?.repaint()}>
          Repaint
        </button>
      </div>
    </div>
  );
}
