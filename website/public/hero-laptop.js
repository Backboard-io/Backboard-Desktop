(() => {
  const scene = document.querySelector(".hero-landscape");
  const display = document.querySelector(".laptop-display");
  const frame = display?.querySelector("iframe");
  if (!scene || !display || !frame) return;
  const tour = scene.closest(".hero-scroll");
  const resize = () => {
    const w = scene.clientWidth,
      h = scene.clientHeight;
    const mobile = matchMedia(
      "(max-width:1100px),(max-aspect-ratio:159/100)",
    ).matches;
    const scale = mobile ? w / 1672 : Math.max(w / 1672, h / 941);
    const imageW = 1672 * scale,
      imageH = 941 * scale;
    const x = (w - imageW) * (mobile ? .5 : .85);
    const y = mobile ? h - imageH : (h - imageH) / 2;
    tour?.style.setProperty("--scene-height", `${h}px`);
    tour?.style.setProperty("--tour-top", `${Math.min(0, innerHeight - h)}px`);
    // Measured bounds of the generated photograph's blank screen.
    const screenW = 972 * scale,
      screenH = 576 * scale;
    Object.assign(display.style, {
      left: `${x + 641 * scale}px`,
      top: `${y + 170 * scale}px`,
      width: `${screenW}px`,
      height: `${screenH}px`,
    });
    frame.style.transform = `scale(${screenW / 1100}, ${screenH / 720})`;
  };
  new ResizeObserver(resize).observe(scene);
  resize();
  const video = display.querySelector("video");
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  if (reduced.matches) {
    video.autoplay = false;
    video.pause();
  }
  const buttons = document.querySelectorAll("[data-laptop-mode]");
  const modes = ["film", "simple", "editor", "advanced"];
  let currentMode = "film";
  const sendMode = () => {
    if (currentMode !== "film") frame.contentWindow.postMessage(
      { type: "laptop-mode", mode: currentMode }, location.origin);
  };
  frame.addEventListener("load", sendMode);
  const setMode = (mode, manual = false) => {
    if (mode === currentMode) return;
    currentMode = mode;
    const film = mode === "film";
    frame.hidden = film;
    video.hidden = !film;
    if (film && (manual || !reduced.matches)) video.play().catch(() => {});
    else video.pause();
    sendMode();
    buttons.forEach(button => button.setAttribute("aria-pressed", String(button.dataset.laptopMode === mode)));
    display.classList.remove("is-switching");
    requestAnimationFrame(() => display.classList.add("is-switching"));
  };
  buttons.forEach(button => button.addEventListener("click", () => setMode(button.dataset.laptopMode, true)));
  let queued = false;
  const updateScroll = () => {
    queued = false;
    if (!tour || reduced.matches) return;
    const distance = parseFloat(getComputedStyle(tour).getPropertyValue("--tour-distance"));
    const offset = Math.max(0, scene.clientHeight - innerHeight);
    const progress = Math.max(0, Math.min(1, (-tour.getBoundingClientRect().top - offset) / distance));
    const index = progress < .12 ? 0 : progress < .42 ? 1 : progress < .72 ? 2 : 3;
    setMode(modes[index]);
  };
  addEventListener("scroll", () => {
    if (!queued) { queued = true; requestAnimationFrame(updateScroll); }
  }, { passive: true });
  updateScroll();
  let resume = false;
  new IntersectionObserver(([entry]) => {
    if (!entry.isIntersecting) {
      resume = !video.paused;
      video.pause();
    } else if (resume && !video.hidden && !reduced.matches) {
      video.play().catch(() => {});
      resume = false;
    }
  }).observe(scene);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      resume = !video.paused;
      video.pause();
    } else if (resume && !video.hidden && !reduced.matches) {
      video.play().catch(() => {});
      resume = false;
    }
  });
})();
