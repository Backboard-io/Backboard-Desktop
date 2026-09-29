// A tiny impasto paint engine: a height field plus a colour field, lit like
// thick acrylic, with miniature figures that walk along painted strokes.

export type RGB = [number, number, number];
type Pt = { x: number; y: number };

export type Stroke = {
  pts: Pt[];
  color: RGB;
  r: number;
  load: number;
  speed: number;
  kind?: "surf" | "walk" | "sky";
};

type Figure = {
  path: Pt[];
  lens: number[];
  total: number;
  s: number;
  v: number;
  kind: "surf" | "walk" | "ski";
  board: string;
  body: string;
};

export const PAINTS: Record<string, RGB> = {
  cream: [246, 240, 226],
  turquoise: [32, 186, 196],
  ocean: [22, 92, 196],
  deep: [14, 44, 128],
  foam: [252, 250, 244],
  sun: [255, 110, 40],
  gold: [255, 196, 46],
  sand: [246, 196, 142],
  pink: [255, 90, 160],
};

const LIGHT = (() => {
  const l = [-0.55, -0.65, 0.55];
  const m = Math.hypot(l[0], l[1], l[2]);
  return l.map((v) => v / m);
})();
const HALF = (() => {
  const h = [LIGHT[0], LIGHT[1], LIGHT[2] + 1];
  const m = Math.hypot(h[0], h[1], h[2]);
  return h.map((v) => v / m);
})();

function rand(a: number, b: number) {
  return a + Math.random() * (b - a);
}

// Catmull-Rom resample so strokes feel hand-pulled rather than polygonal.
function smooth(pts: Pt[], step: number): Pt[] {
  if (pts.length < 3) return pts;
  const out: Pt[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];
    const n = Math.max(1, Math.ceil(Math.hypot(p2.x - p1.x, p2.y - p1.y) / step));
    for (let k = 0; k < n; k++) {
      const t = k / n;
      const t2 = t * t;
      const t3 = t2 * t;
      out.push({
        x:
          0.5 *
          (2 * p1.x +
            (-p0.x + p2.x) * t +
            (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
            (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
        y:
          0.5 *
          (2 * p1.y +
            (-p0.y + p2.y) * t +
            (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
            (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
      });
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}

export function createImpasto(
  canvas: HTMLCanvasElement,
  overlay: HTMLCanvasElement,
  opts: { reduced: boolean },
) {
  const ctx = canvas.getContext("2d", { willReadFrequently: false })!;
  const octx = overlay.getContext("2d")!;
  let W = 0;
  let H = 0;
  let cssW = 0;
  let cssH = 0;
  let height = new Float32Array(0);
  let col = new Float32Array(0);
  let img: ImageData;
  let dirty = { x0: 1e9, y0: 1e9, x1: -1, y1: -1 };
  type Job = { stroke: Stroke; path: Pt[]; i: number; bristles: Float32Array };
  let queue: Job[] = [];
  let figures: Figure[] = [];
  let raf = 0;
  let running = false;
  let live: { stroke: Stroke; last: Pt; bristles: Float32Array; pts: Pt[] } | null = null;

  function markDirty(x0: number, y0: number, x1: number, y1: number) {
    dirty.x0 = Math.min(dirty.x0, x0);
    dirty.y0 = Math.min(dirty.y0, y0);
    dirty.x1 = Math.max(dirty.x1, x1);
    dirty.y1 = Math.max(dirty.y1, y1);
  }

  function bristleSet() {
    const b = new Float32Array(48);
    for (let i = 0; i < b.length; i++) b[i] = 0.72 + Math.random() * 0.28;
    return b;
  }

  function dab(
    x: number,
    y: number,
    r: number,
    c: RGB,
    dx: number,
    dy: number,
    load: number,
    bristles: Float32Array,
  ) {
    const x0 = Math.max(1, Math.floor(x - r));
    const x1 = Math.min(W - 2, Math.ceil(x + r));
    const y0 = Math.max(1, Math.floor(y - r));
    const y1 = Math.min(H - 2, Math.ceil(y + r));
    if (x0 > x1 || y0 > y1) return;
    const r2 = r * r;
    const nb = bristles.length;
    for (let py = y0; py <= y1; py++) {
      for (let px = x0; px <= x1; px++) {
        const ox = px - x;
        const oy = py - y;
        const d2 = (ox * ox + oy * oy) / r2;
        if (d2 >= 1) continue;
        const across = (ox * -dy + oy * dx) / r;
        const b = bristles[Math.min(nb - 1, Math.max(0, Math.floor((across + 1) * 0.5 * nb)))];
        const fall = 1 - d2;
        const i = py * W + px;
        const d = Math.sqrt(d2);
        const ridge = Math.exp(-((d - 0.82) * (d - 0.82)) / 0.012);
        const target = load * r * (0.22 * Math.sqrt(fall) * b + 0.1 * ridge);
        const k = fall * 0.5;
        height[i] = height[i] * (1 - k) + target * k + load * ridge * r * 0.02;
        const t = Math.min(1, fall * 1.6) * (0.55 + 0.45 * b);
        const j = i * 3;
        const jitter = (b - 0.86) * 30;
        col[j] += (c[0] + jitter - col[j]) * t;
        col[j + 1] += (c[1] + jitter - col[j + 1]) * t;
        col[j + 2] += (c[2] + jitter - col[j + 2]) * t;
      }
    }
    markDirty(x0 - 1, y0 - 1, x1 + 1, y1 + 1);
  }

  function shade() {
    if (dirty.x1 < 0) return;
    const x0 = Math.max(1, dirty.x0);
    const y0 = Math.max(1, dirty.y0);
    const x1 = Math.min(W - 2, dirty.x1);
    const y1 = Math.min(H - 2, dirty.y1);
    const data = img.data;
    const S = 0.55;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const i = y * W + x;
        const hx = (height[i + 1] - height[i - 1]) * S;
        const hy = (height[i + W] - height[i - W]) * S;
        const inv = 1 / Math.sqrt(hx * hx + hy * hy + 1);
        const nx = -hx * inv;
        const ny = -hy * inv;
        const nz = inv;
        const diff = Math.max(0, nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2]);
        let sp = Math.max(0, nx * HALF[0] + ny * HALF[1] + nz * HALF[2]);
        sp = sp * sp;
        sp = sp * sp;
        sp = sp * sp;
        sp = sp * sp;
        const l = 0.62 + 0.5 * diff;
        const j = i * 3;
        const o = i * 4;
        data[o] = col[j] * l + sp * 45;
        data[o + 1] = col[j + 1] * l + sp * 45;
        data[o + 2] = col[j + 2] * l + sp * 42;
        data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0, x0, y0, x1 - x0 + 1, y1 - y0 + 1);
    dirty = { x0: 1e9, y0: 1e9, x1: -1, y1: -1 };
  }

  // Cream ground with directional knife texture.
  function ground() {
    const cream = PAINTS.cream;
    const waves: [number, number, number, number][] = [];
    for (let k = 0; k < 7; k++)
      waves.push([rand(0.004, 0.03), rand(0.01, 0.05), rand(0, 6.28), rand(0.6, 2.2)]);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let h = 0;
        for (const [fx, fy, ph, a] of waves) h += Math.sin(x * fx + y * fy + ph + Math.sin(y * fy * 3) * 2) * a * 0.45;
        const i = y * W + x;
        height[i] = h + Math.random() * 0.5;
        const j = i * 3;
        const v = (Math.random() - 0.5) * 6;
        col[j] = cream[0] + v;
        col[j + 1] = cream[1] + v;
        col[j + 2] = cream[2] + v;
      }
    }
    // A handful of broad palette-knife swipes in the ground.
    for (let k = 0; k < 14; k++) {
      const x = rand(0, W);
      const y = rand(0, H);
      const len = rand(W * 0.1, W * 0.3);
      const a = rand(-0.5, 0.5);
      const pts = [0, 0.33, 0.66, 1].map((t) => ({
        x: x + Math.cos(a) * len * t,
        y: y + Math.sin(a) * len * t + Math.sin(t * 3) * 10,
      }));
      runStrokeNow({ pts, color: [246 + rand(-4, 4), 239, 224 + rand(-6, 6)] as RGB, r: rand(18, 40) * (W / 900), load: 0.1, speed: 1 });
    }
    markDirty(0, 0, W - 1, H - 1);
  }

  function prep(stroke: Stroke): Job {
    return { stroke, path: smooth(stroke.pts, Math.max(1, stroke.r * 0.22)), i: 0, bristles: bristleSet() };
  }

  function stepStroke(q: Job, n: number) {
    const { path, stroke } = q;
    for (let k = 0; k < n && q.i < path.length; k++, q.i++) {
      const a = path[Math.max(0, q.i - 1)];
      const b = path[Math.min(path.length - 1, q.i + 1)];
      const m = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const taper = Math.min(1, q.i / 6, (path.length - q.i) / 8 + 0.35);
      const p = path[q.i];
      dab(p.x, p.y, stroke.r * (0.55 + 0.45 * taper), stroke.color, (b.x - a.x) / m, (b.y - a.y) / m, stroke.load, q.bristles);
    }
    return q.i >= path.length;
  }

  function runStrokeNow(stroke: Stroke) {
    const q = prep(stroke);
    stepStroke(q, 1e9);
    return q.path;
  }

  const boardColors = ["#ff3b2f", "#ffd400", "#ff4da6", "#ffffff", "#19b7c9"];
  const bodyColors = ["#1a1a1a", "#3a2a22", "#20304a", "#5a3a2a"];

  function addFigure(path: Pt[], kind: Figure["kind"]) {
    if (path.length < 8) return;
    const lens = [0];
    for (let i = 1; i < path.length; i++)
      lens.push(lens[i - 1] + Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y));
    const total = lens[lens.length - 1];
    if (total < 40) return;
    figures.push({
      path,
      lens,
      total,
      s: rand(0, total),
      v: (kind === "surf" ? rand(0.5, 0.9) : rand(0.18, 0.3)) * (Math.random() < 0.5 ? -1 : 1),
      kind,
      board: boardColors[Math.floor(Math.random() * boardColors.length)],
      body: bodyColors[Math.floor(Math.random() * bodyColors.length)],
    });
    if (figures.length > 14) figures.shift();
  }

  function at(f: Figure, s: number) {
    let lo = 0;
    let hi = f.lens.length - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (f.lens[mid] < s) lo = mid;
      else hi = mid;
    }
    const a = f.path[lo];
    const b = f.path[hi];
    const t = (s - f.lens[lo]) / (f.lens[hi] - f.lens[lo] || 1);
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, ang: Math.atan2(b.y - a.y, b.x - a.x) };
  }

  function drawFigures(dt: number) {
    const dpr = overlay.width / cssW;
    octx.setTransform(1, 0, 0, 1, 0, 0);
    octx.clearRect(0, 0, overlay.width, overlay.height);
    const k = cssW / W;
    octx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const size = Math.max(1, Math.min(1.5, cssW / 950));
    for (const f of figures) {
      f.s += f.v * dt * 0.06;
      if (f.s < 0 || f.s > f.total) {
        f.v = -f.v;
        f.s = Math.max(0, Math.min(f.total, f.s));
      }
      const p = at(f, f.s);
      const x = p.x * k;
      const y = p.y * k;
      const facing = f.v < 0 ? p.ang + Math.PI : p.ang;
      octx.save();
      octx.translate(x, y);
      octx.scale(size, size);
      // long low shadow to the lower right, like late sun
      octx.fillStyle = "rgba(20,30,50,0.28)";
      octx.beginPath();
      octx.ellipse(6, 4, 8, 1.8, 0.45, 0, Math.PI * 2);
      octx.fill();
      if (f.kind !== "walk") {
        octx.save();
        octx.rotate(facing);
        octx.fillStyle = f.board;
        octx.strokeStyle = "rgba(0,0,0,.35)";
        octx.lineWidth = 0.6;
        octx.beginPath();
        octx.ellipse(0, 1.5, 6.5, 1.6, 0, 0, Math.PI * 2);
        octx.fill();
        octx.stroke();
        octx.restore();
      }
      // body
      const bob = f.kind === "walk" ? Math.sin(f.s * 0.6) * 0.5 : 0;
      octx.strokeStyle = f.body;
      octx.lineCap = "round";
      octx.lineWidth = 2;
      octx.beginPath();
      octx.moveTo(0, 0.5);
      octx.lineTo(0, -4.5 + bob);
      octx.stroke();
      if (f.kind === "walk") {
        // board carried under the arm
        octx.save();
        octx.rotate(-1.1);
        octx.fillStyle = f.board;
        octx.beginPath();
        octx.ellipse(-2.5, -1, 5, 1.2, 0, 0, Math.PI * 2);
        octx.fill();
        octx.restore();
      }
      octx.fillStyle = "#6b4630";
      octx.beginPath();
      octx.arc(0, -6 + bob, 1.4, 0, Math.PI * 2);
      octx.fill();
      octx.restore();
    }
  }

  // The scene the ghost painter makes: sea, foam, sand, sun.
  function scene(): Stroke[] {
    const s: Stroke[] = [];
    const u = W / 900;
    const narrow = W / H < 1.1;
    // A wave ribbon crossing the lower right on a diagonal; the rest stays
    // white paint, like Bronkhorst's open canvases.
    const ribbon = (off: number, wob: number, from: number, to: number) => {
      const pts: Pt[] = [];
      const x0 = narrow ? -0.1 : 0.34;
      for (let t = from; t <= to + 1e-4; t += 0.06) {
        const x = (x0 + (1.12 - x0) * t) * W;
        const y = ((narrow ? 1.02 : 1.04) - (narrow ? 0.3 : 0.5) * t + off) * H + Math.sin(t * 7 + wob) * 0.018 * H;
        pts.push({ x, y });
      }
      return pts;
    };
    const ph = rand(0, 6);
    const sea: [number, keyof typeof PAINTS, number][] = [
      [0.1, "deep", 30],
      [0.06, "ocean", 28],
      [0.02, "ocean", 24],
      [-0.02, "turquoise", 22],
      [-0.055, "turquoise", 18],
    ];
    for (const [off, c, r] of sea)
      s.push({ pts: ribbon(off, ph + off * 20, 0, 1), color: PAINTS[c], r: r * u, load: 1, speed: 4, kind: "surf" });
    for (const [off, from] of [[-0.075, 0.15], [-0.01, 0.3], [0.045, 0.1]] as const)
      s.push({ pts: ribbon(off, ph + off * 20, from, 1), color: PAINTS.foam, r: 6 * u, load: 1.4, speed: 5, kind: "surf" });
    // a little sand spit tucked under the wave
    const sx = narrow ? 0.62 : 0.8;
    s.push({
      pts: [
        { x: sx * W, y: 1.06 * H },
        { x: (sx + 0.08) * W, y: 0.97 * H },
        { x: (sx + 0.2) * W, y: 0.92 * H },
        { x: 1.08 * W, y: 0.9 * H },
      ],
      color: PAINTS.sand,
      r: 26 * u,
      load: 0.9,
      speed: 3,
      kind: "walk",
    });
    // sun: a spiral of thick daubs, top right
    const cx = (narrow ? 0.78 : 0.84) * W;
    const cy = (narrow ? 0.5 : 0.2) * H;
    const R = Math.min(W, H) * 0.085;
    const spiral: Pt[] = [];
    for (let a = 0; a < Math.PI * 7; a += 0.35) {
      const rr = R * (1 - a / (Math.PI * 7.4));
      spiral.push({ x: cx + Math.cos(a) * rr, y: cy + Math.sin(a) * rr });
    }
    s.push({ pts: spiral, color: PAINTS.sun, r: 12 * u, load: 1.2, speed: 6, kind: "sky" });
    s.push({
      pts: spiral.slice(10).map((p) => ({ x: cx + (p.x - cx) * 0.5, y: cy + (p.y - cy) * 0.5 })),
      color: PAINTS.gold,
      r: 8 * u,
      load: 1.2,
      speed: 6,
      kind: "sky",
    });
    return s;
  }

  function enqueue(stroke: Stroke) {
    queue.push(prep(stroke));
  }

  function finish(q: Job) {
    const kind = q.stroke.kind;
    if (kind === "surf" && Math.random() < 0.7) addFigure(q.path, "surf");
    if (kind === "walk") {
      addFigure(q.path, "walk");
      addFigure(q.path, "walk");
    }
  }

  let last = 0;
  function frame(now: number) {
    const dt = Math.min(50, now - (last || now));
    last = now;
    if (queue.length) {
      const q = queue[0];
      if (stepStroke(q, Math.ceil(q.stroke.speed * (dt / 16)))) {
        finish(q);
        queue.shift();
      }
    }
    shade();
    drawFigures(dt);
    if (running) raf = requestAnimationFrame(frame);
  }

  function resize() {
    const rect = canvas.getBoundingClientRect();
    cssW = Math.max(1, rect.width);
    cssH = Math.max(1, rect.height);
    const scale = Math.min(0.75, 1000 / cssW);
    W = Math.round(cssW * scale);
    H = Math.round(cssH * scale);
    canvas.width = W;
    canvas.height = H;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    overlay.width = Math.round(cssW * dpr);
    overlay.height = Math.round(cssH * dpr);
    height = new Float32Array(W * H);
    col = new Float32Array(W * H * 3);
    img = ctx.createImageData(W, H);
  }

  function repaint() {
    queue = [];
    figures = [];
    resize();
    ground();
    const strokes = scene();
    if (opts.reduced) {
      for (const st of strokes) {
        const q = prep(st);
        stepStroke(q, 1e9);
        finish(q);
      }
      shade();
      drawFigures(0);
    } else {
      strokes.forEach(enqueue);
      shade();
    }
  }

  // Pointer painting: visitors pull their own strokes.
  function toLocal(e: PointerEvent): Pt {
    const r = canvas.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H };
  }
  let color: RGB = PAINTS.turquoise;
  let brush = 18;
  function down(e: PointerEvent) {
    canvas.setPointerCapture(e.pointerId);
    const p = toLocal(e);
    live = { stroke: { pts: [p], color, r: brush * (W / 900), load: 1.1, speed: 0 }, last: p, bristles: bristleSet(), pts: [p] };
    dab(p.x, p.y, live.stroke.r * 0.7, color, 1, 0, 1.1, live.bristles);
    if (!running) shade();
  }
  function move(e: PointerEvent) {
    if (!live) return;
    const p = toLocal(e);
    const d = Math.hypot(p.x - live.last.x, p.y - live.last.y);
    const step = Math.max(1, live.stroke.r * 0.22);
    if (d < step) return;
    const n = Math.floor(d / step);
    const dx = (p.x - live.last.x) / d;
    const dy = (p.y - live.last.y) / d;
    for (let k = 1; k <= n; k++) {
      const q = { x: live.last.x + dx * step * k, y: live.last.y + dy * step * k };
      dab(q.x, q.y, live.stroke.r, color, dx, dy, 1.1, live.bristles);
      live.pts.push(q);
    }
    live.last = live.pts[live.pts.length - 1];
    if (!running) shade();
  }
  function up() {
    if (!live) return;
    const path = live.pts;
    const light = color[0] + color[1] + color[2] > 540;
    addFigure(path, color === PAINTS.sand || color === PAINTS.gold ? "walk" : light ? "ski" : "surf");
    live = null;
  }
  canvas.addEventListener("pointerdown", down);
  canvas.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);

  function start() {
    if (running) return;
    running = true;
    last = 0;
    raf = requestAnimationFrame(frame);
  }
  function stop() {
    running = false;
    cancelAnimationFrame(raf);
  }

  repaint();

  return {
    start,
    stop,
    repaint,
    setColor(c: RGB) {
      color = c;
    },
    setBrush(r: number) {
      brush = r;
    },
    width: () => cssW,
    destroy() {
      stop();
      canvas.removeEventListener("pointerdown", down);
      canvas.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    },
  };
}
