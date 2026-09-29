"use client";

import { useEffect, useRef } from "react";

type Print = { x: number; y: number; a: number; t: number };
type Walker = {
  x: number;
  y: number;
  dir: 1 | -1;
  baseY: number;
  amp: number;
  freq: number;
  phase: number;
  speed: number;
  shirt: string;
  board: string | null;
  prints: Print[];
  stride: number;
  side: 1 | -1;
  path?: { x: number; y: number }[];
  s?: number;
  done?: boolean;
};

const SHIRTS = ["#ffffff", "#ef5a24", "#1a7fb3", "#f2c14e", "#1c1a17"];
const BOARDS = ["#ef5a24", "#f2c14e", "#ffffff", "#1fa9b8"];
const PRINT_LIFE = 18000;

// Tiny beachgoers wander across the sand painting, leaving footprints that
// slowly fill back in. Drag across the sand to lay a path for someone to walk.
export function SandTracks({ src, alt }: { src: string; alt: string }) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const el = wrap.current!;
    const cv = canvas.current!;
    const ctx = cv.getContext("2d")!;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let W = 0;
    let H = 0;
    let walkers: Walker[] = [];
    let raf = 0;
    let running = false;
    let last = 0;
    let drawing: { x: number; y: number }[] | null = null;

    const size = () => {
      const r = el.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      W = r.width;
      H = r.height;
      cv.width = Math.round(W * dpr);
      cv.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    const scale = () => Math.max(0.9, Math.min(1.45, W / 1050));

    const spawn = (x?: number): Walker => {
      const dir: 1 | -1 = Math.random() < 0.5 ? 1 : -1;
      return {
        x: x ?? (dir === 1 ? -20 : W + 20),
        y: 0,
        dir,
        baseY: H * (0.5 + Math.random() * 0.42),
        amp: 6 + Math.random() * 18,
        freq: 0.004 + Math.random() * 0.006,
        phase: Math.random() * 6.28,
        speed: 16 + Math.random() * 14,
        shirt: SHIRTS[Math.floor(Math.random() * SHIRTS.length)],
        board: Math.random() < 0.45 ? BOARDS[Math.floor(Math.random() * BOARDS.length)] : null,
        prints: [],
        stride: 0,
        side: 1,
      };
    };

    const step = (k: Walker, dt: number, now: number) => {
      const px = k.x;
      const py = k.y;
      if (k.path) {
        k.s = (k.s ?? 0) + (k.speed * 1.3 * dt) / 1000;
        const i = Math.floor(k.s / 4);
        if (i >= k.path.length - 1) {
          k.done = true;
          return;
        }
        k.x = k.path[i].x;
        k.y = k.path[i].y;
      } else {
        k.x += (k.dir * k.speed * dt) / 1000;
        k.y = k.baseY + Math.sin(k.phase + k.x * k.freq) * k.amp;
      }
      const moved = Math.hypot(k.x - px, k.y - py);
      if (!Number.isFinite(moved) || py === 0) return;
      k.stride += moved;
      if (k.stride > 5.5) {
        k.stride = 0;
        k.side = k.side === 1 ? -1 : 1;
        const a = Math.atan2(k.y - py, k.x - px);
        k.prints.push({
          x: k.x + Math.cos(a + Math.PI / 2) * 1.8 * k.side,
          y: k.y + Math.sin(a + Math.PI / 2) * 1.8 * k.side,
          a,
          t: now,
        });
      }
    };

    // A footprint: a small pressed dip with a lit rim.
    const drawPrints = (k: Walker, now: number) => {
      for (const p of k.prints) {
        const life = Math.max(0, 1 - (now - p.t) / PRINT_LIFE);
        if (life <= 0) continue;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.a);
        ctx.fillStyle = `rgba(150,96,52,${0.32 * life})`;
        ctx.beginPath();
        ctx.ellipse(0, 0, 2.1, 1.05, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = `rgba(255,248,236,${0.7 * life})`;
        ctx.beginPath();
        ctx.ellipse(-0.4, -0.7, 1.8, 0.45, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    };

    const drawWalker = (k: Walker, t: number) => {
      const s = scale();
      const bob = Math.sin(t * 0.012 + k.phase) * 0.5;
      ctx.save();
      ctx.translate(k.x, k.y);
      ctx.scale(s, s);
      // long late-afternoon shadow
      ctx.fillStyle = "rgba(110,70,40,0.25)";
      ctx.beginPath();
      ctx.ellipse(8, 3, 11, 1.8, 0.35, 0, Math.PI * 2);
      ctx.fill();
      // legs
      ctx.strokeStyle = "#3a2a20";
      ctx.lineWidth = 1.3;
      ctx.lineCap = "round";
      const swing = Math.sin(t * 0.012 + k.phase) * 1.4;
      ctx.beginPath();
      ctx.moveTo(0, -4);
      ctx.lineTo(-swing, 0);
      ctx.moveTo(0, -4);
      ctx.lineTo(swing, 0);
      ctx.stroke();
      // board under the arm
      if (k.board) {
        ctx.save();
        ctx.translate(2.6 * k.dir, -6 + bob);
        ctx.rotate(-1.35 * k.dir);
        ctx.fillStyle = k.board;
        ctx.strokeStyle = "rgba(0,0,0,.25)";
        ctx.lineWidth = 0.5;
        ctx.beginPath();
        ctx.ellipse(0, 0, 6, 1.4, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.restore();
      }
      // torso and head
      ctx.fillStyle = k.shirt;
      ctx.strokeStyle = "rgba(0,0,0,.2)";
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.roundRect(-1.9, -9 + bob, 3.8, 5.2, 1.4);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = "#7a4e32";
      ctx.beginPath();
      ctx.arc(0, -10.6 + bob, 1.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    };

    const render = (now: number) => {
      ctx.clearRect(0, 0, W, H);
      for (const k of walkers) drawPrints(k, now);
      if (drawing && drawing.length > 1) {
        ctx.beginPath();
        ctx.moveTo(drawing[0].x, drawing[0].y);
        for (const d of drawing) ctx.lineTo(d.x, d.y);
        ctx.strokeStyle = "rgba(239,90,36,.6)";
        ctx.setLineDash([3, 5]);
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.setLineDash([]);
      }
      const ordered = walkers.filter((k) => !k.done && k.x > -20 && k.x < W + 20).sort((a, b) => a.y - b.y);
      for (const k of ordered) drawWalker(k, now);
    };

    const frame = (now: number) => {
      const dt = Math.min(60, now - (last || now));
      last = now;
      for (const k of walkers) if (!k.done) step(k, dt, now);
      walkers = walkers.filter((k) => {
        const gone = k.done || k.x < -30 || k.x > W + 30;
        if (!gone) return true;
        const tail = k.prints[k.prints.length - 1];
        return !!tail && now - tail.t < PRINT_LIFE;
      });
      const active = walkers.filter((k) => !k.done && !k.path && k.x >= -30 && k.x <= W + 30).length;
      if (active < (W < 760 ? 3 : 6) && Math.random() < 0.015) walkers.push(spawn());
      render(now);
      if (running) raf = requestAnimationFrame(frame);
    };

    // Start with people already mid-stroll, trailing prints behind them.
    const seed = () => {
      walkers = [];
      const now = performance.now();
      const n = W < 760 ? 3 : 6;
      for (let i = 0; i < n; i++) {
        const k = spawn();
        const target = W * (0.15 + Math.random() * 0.8);
        const start = k.dir === 1 ? Math.max(-20, target - W * 0.35) : Math.min(W + 20, target + W * 0.35);
        k.x = start;
        k.y = k.baseY + Math.sin(k.phase + k.x * k.freq) * k.amp;
        let t = now - (Math.abs(target - start) / k.speed) * 1000;
        while ((k.dir === 1 && k.x < target) || (k.dir === -1 && k.x > target)) {
          step(k, 50, t);
          t += 50;
        }
        walkers.push(k);
      }
    };

    const toLocal = (e: PointerEvent) => {
      const r = cv.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const down = (e: PointerEvent) => {
      if (e.pointerType === "touch") return;
      cv.setPointerCapture(e.pointerId);
      drawing = [toLocal(e)];
    };
    const move = (e: PointerEvent) => {
      if (!drawing) return;
      const p = toLocal(e);
      const lp = drawing[drawing.length - 1];
      const d = Math.hypot(p.x - lp.x, p.y - lp.y);
      for (let k = 4; k <= d; k += 4) drawing.push({ x: lp.x + ((p.x - lp.x) * k) / d, y: lp.y + ((p.y - lp.y) * k) / d });
      if (!running) render(performance.now());
    };
    const up = () => {
      if (!drawing) return;
      if (drawing.length > 8) {
        const k = spawn();
        k.path = drawing;
        k.s = 0;
        k.x = drawing[0].x;
        k.y = drawing[0].y;
        k.dir = drawing[drawing.length - 1].x >= drawing[0].x ? 1 : -1;
        walkers.push(k);
      }
      drawing = null;
    };

    size();
    seed();
    render(performance.now());

    const start = () => {
      if (running || reduced) return;
      running = true;
      last = 0;
      raf = requestAnimationFrame(frame);
    };
    const stop = () => {
      running = false;
      cancelAnimationFrame(raf);
    };
    let visible = true;
    const sync = () => (visible && !document.hidden ? start() : stop());
    const io = new IntersectionObserver(([e]) => {
      visible = e.isIntersecting;
      sync();
    });
    io.observe(el);
    document.addEventListener("visibilitychange", sync);
    let lastW = W;
    const onResize = () => {
      size();
      if (Math.abs(W - lastW) > 60) {
        lastW = W;
        seed();
      }
      render(performance.now());
    };
    window.addEventListener("resize", onResize);
    cv.addEventListener("pointerdown", down);
    cv.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    sync();

    return () => {
      stop();
      io.disconnect();
      document.removeEventListener("visibilitychange", sync);
      window.removeEventListener("resize", onResize);
      cv.removeEventListener("pointerdown", down);
      cv.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, []);

  return (
    <div className="slope" ref={wrap}>
      <img src={src} alt={alt} />
      <canvas ref={canvas} aria-hidden="true" />
    </div>
  );
}
