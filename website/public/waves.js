/* Photo-based water motion. The source photograph stays independently deployable. */
(() => {
  const canvas = document.createElement("canvas");
  canvas.className = "wave-background";
  canvas.setAttribute("aria-hidden", "true");
  document.body.prepend(canvas);
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) {
    canvas.remove();
    return;
  }
  const photo = new Image();
  photo.src = new URL(
    "assets/motion-surf.jpeg",
    document.currentScript.src,
  ).href;
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  const button = document.createElement("button");
  button.className = "wave-toggle";
  button.type = "button";
  document.body.append(button);
  let width = 0,
    height = 0,
    frame = 0,
    previous = 0,
    time = 0;
  let paused = reduced.matches;
  function label() {
    button.textContent = paused ? "Play waves ↗" : "Pause waves Ⅱ";
    button.setAttribute(
      "aria-label",
      paused ? "Play background animation" : "Pause background animation",
    );
  }
  function size() {
    width = innerWidth;
    height = innerHeight;
    const ratio = Math.min(devicePixelRatio || 1, 1.5);
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    draw();
  }
  function draw() {
    ctx.fillStyle = "#ed823e";
    ctx.fillRect(0, 0, width, height);
    if (!photo.complete || !photo.naturalWidth) return;
    // Overscan avoids exposed edges during the slow camera drift.
    const scale =
      Math.max(width / photo.naturalWidth, height / photo.naturalHeight) * 1.08;
    const dw = photo.naturalWidth * scale,
      dh = photo.naturalHeight * scale;
    const left = (width - dw) / 2 + Math.sin(time * 0.16) * 8;
    const top = (height - dh) / 2 + Math.sin(time * 0.21) * 4;
    // Sample horizontal strips from the real image, with almost no distortion
    // around the surfer; the water and streaked reflections carry the motion.
    for (let y = 0; y < height; y += 3) {
      const sourceY = (y - top) / scale;
      const depth = sourceY / photo.naturalHeight;
      const water = Math.exp(-Math.pow((depth - 0.57) / 0.13, 2));
      const reflection = Math.max(0, (depth - 0.66) / 0.34);
      const motion =
        Math.sin(depth * 23 - time * 0.65) * (water * 4 + reflection * 10) +
        Math.sin(depth * 49 - time * 0.38) * reflection * 2;
      ctx.drawImage(
        photo,
        0,
        sourceY,
        photo.naturalWidth,
        3.5 / scale,
        left + motion,
        y,
        dw,
        3.5,
      );
    }
    // A neutral scrim keeps navigation and product copy legible without tinting
    // the turquoise wave orange or hiding the photographic texture.
    const shade = ctx.createLinearGradient(0, 0, width, 0);
    shade.addColorStop(0, "rgba(18,24,29,.62)");
    shade.addColorStop(0.55, "rgba(18,24,29,.30)");
    shade.addColorStop(1, "rgba(18,24,29,.12)");
    ctx.fillStyle = shade;
    ctx.fillRect(0, 0, width, height);
    const edge = ctx.createLinearGradient(0, 0, 0, height);
    edge.addColorStop(0, "rgba(19,22,27,.28)");
    edge.addColorStop(0.45, "rgba(19,22,27,0)");
    edge.addColorStop(1, "rgba(19,22,27,.24)");
    ctx.fillStyle = edge;
    ctx.fillRect(0, 0, width, height);
  }
  function tick(now) {
    frame = 0;
    if (paused || document.hidden) return;
    if (now - previous >= 32) {
      time += Math.min((now - previous) / 1000, 0.05);
      previous = now;
      draw();
    }
    frame = requestAnimationFrame(tick);
  }
  function sync() {
    cancelAnimationFrame(frame);
    frame = 0;
    previous = performance.now();
    label();
    if (!paused && !document.hidden && photo.complete)
      frame = requestAnimationFrame(tick);
  }
  photo.addEventListener("load", () => {
    draw();
    sync();
  });
  photo.addEventListener("error", () => {
    button.remove();
    canvas.remove();
  });
  button.addEventListener("click", () => {
    paused = !paused;
    sync();
  });
  reduced.addEventListener("change", () => {
    paused = reduced.matches;
    sync();
  });
  document.addEventListener("visibilitychange", sync);
  window.addEventListener("resize", size, { passive: true });
  size();
  sync();
})();
