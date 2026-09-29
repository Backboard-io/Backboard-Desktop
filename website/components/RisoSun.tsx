"use client";

import { useEffect, useRef } from "react";

// A risograph halftone scene drawn live: a sun in pink and yellow over blue
// halftone waves, three inks slightly misregistered and overprinted. The sun
// drifts toward the pointer.
export type RisoInks = { sea: string; rim: string; core: string };

// Nash's fluorescent set; the Studio hub passes sunset inks instead.
const NEON: RisoInks = { sea: "#1d3fd8", rim: "#ff4fa0", core: "#ffd61a" };

export function RisoSun({
  inks = NEON,
  horizon = 0.72,
  sunY = 0.4,
  radius = 0.2,
}: {
  inks?: RisoInks;
  horizon?: number;
  sunY?: number;
  radius?: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const cv = ref.current!;
    const ctx = cv.getContext("2d")!;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let W = 0;
    let H = 0;
    let raf = 0;
    let running = false;
    const sun = { x: 0.7, y: sunY };
    const aim = { x: 0.7, y: sunY };

    const size = () => {
      const r = cv.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      W = r.width;
      H = r.height;
      cv.width = Math.round(W * dpr);
      cv.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    // One ink layer: a rotated dot grid whose dot radius follows density().
    const layer = (color: string, angle: number, cell: number, off: [number, number], density: (x: number, y: number) => number) => {
      ctx.fillStyle = color;
      const ca = Math.cos(angle);
      const sa = Math.sin(angle);
      const reach = Math.hypot(W, H) / cell + 2;
      ctx.beginPath();
      for (let i = -reach; i < reach; i++) {
        for (let j = -reach; j < reach; j++) {
          const u = i * cell;
          const v = j * cell;
          const x = W / 2 + u * ca - v * sa;
          const y = H / 2 + u * sa + v * ca;
          if (x < -cell || y < -cell || x > W + cell || y > H + cell) continue;
          const d = density(x / W, y / H);
          if (d < 0.03) continue;
          const r = cell * 0.62 * Math.sqrt(Math.min(1, d));
          ctx.moveTo(x + off[0] + r, y + off[1]);
          ctx.arc(x + off[0], y + off[1], r, 0, Math.PI * 2);
        }
      }
      ctx.fill();
    };

    const draw = (t: number) => {
      sun.x += (aim.x - sun.x) * 0.03;
      sun.y += (aim.y - sun.y) * 0.03;
      ctx.clearRect(0, 0, W, H);
      ctx.globalCompositeOperation = "multiply";
      const aspect = W / H;
      const R = radius;
      const sunD = (x: number, y: number) => {
        const d = Math.hypot((x - sun.x) * aspect, y - sun.y) / R;
        return d > 1.25 ? 0 : d > 1 ? (1.25 - d) * 1.2 : 1 - d * 0.25;
      };
      const sea = (x: number, y: number) => {
        if (y < horizon - 0.04) return 0;
        const wave = Math.sin(x * 14 + t * 0.0012 + y * 30) * 0.5 + 0.5;
        return Math.min(1, (y - horizon) * 3 + 0.25) * (0.55 + wave * 0.45);
      };
      const cell = Math.max(7, Math.min(11, W / 120));
      layer(inks.core, 0, cell, [0, 0], (x, y) => sunD(x, y) * (y < horizon ? 1 : 0.35));
      layer(inks.rim, 0.26, cell, [1.5, -1], (x, y) => {
        const s = sunD(x, y);
        return (s > 0.05 ? Math.min(1, (1 - s) * 1.6 + 0.2) : 0) + (y > horizon ? sea(x, y) * 0.25 : 0);
      });
      layer(inks.sea, 0.78, cell, [-1.2, 1.4], (x, y) => sea(x, y));
      ctx.globalCompositeOperation = "source-over";
    };

    const loop = (t: number) => {
      draw(t);
      if (running) raf = requestAnimationFrame(loop);
    };
    const onMove = (e: PointerEvent) => {
      const r = cv.getBoundingClientRect();
      aim.x = 0.4 + ((e.clientX - r.left) / r.width) * 0.5;
      aim.y = sunY - 0.12 + ((e.clientY - r.top) / r.height) * 0.24;
    };

    size();
    draw(0);
    let visible = true;
    const sync = () => {
      const go = visible && !document.hidden && !reduced;
      if (go && !running) {
        running = true;
        raf = requestAnimationFrame(loop);
      } else if (!go) {
        running = false;
        cancelAnimationFrame(raf);
      }
    };
    const io = new IntersectionObserver(([e]) => {
      visible = e.isIntersecting;
      sync();
    });
    io.observe(cv);
    document.addEventListener("visibilitychange", sync);
    const onResize = () => {
      size();
      draw(performance.now());
    };
    window.addEventListener("resize", onResize);
    window.addEventListener("pointermove", onMove);
    sync();
    return () => {
      running = false;
      cancelAnimationFrame(raf);
      io.disconnect();
      document.removeEventListener("visibilitychange", sync);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("pointermove", onMove);
    };
  }, [inks, horizon, sunY, radius]);

  return <canvas ref={ref} className="riso-sun" aria-hidden="true" />;
}
