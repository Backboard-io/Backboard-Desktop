(() => {
  const hero = document.querySelector('.hero-landscape');
  if (!hero) return;
  const picker = hero.querySelector('#hero-scenery-picker');
  const names = [...picker.options].map(option => option.value);
  const images = new Map();
  let selection = 0;
  const pause = hero.querySelector('.scenery-pause');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  let current = 'meadow', paused = reduced.matches, visible = false, timer;
  const sync = () => {
    clearTimeout(timer);
    const active = visible && !document.hidden && !paused && !reduced.matches;
    if (active) timer = setTimeout(() => select(names[(names.indexOf(current) + 1) % names.length]), 8000);
  };
  const select = async (name) => {
    const request = ++selection;
    if (!images.has(name)) {
      const image = new Image();
      image.src = `assets/laptop-${name}-hero.png`;
      images.set(name, image);
    }
    try { await images.get(name).decode(); } catch { sync(); return; }
    if (request !== selection) return;
    current = name;
    hero.dataset.scenery = name;
    picker.value = name;
    sync();
  };
  const updatePause = () => {
    pause.setAttribute('aria-pressed', String(paused));
    pause.setAttribute('aria-label', paused ? 'Play scenery animation' : 'Pause scenery animation');
    pause.textContent = paused ? '▶' : 'Ⅱ';
    sync();
  };
  picker.addEventListener('change', () => select(picker.value));
  pause.addEventListener('click', () => { paused = !paused; updatePause(); });
  new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; sync(); }).observe(hero);
  document.addEventListener('visibilitychange', sync);
  reduced.addEventListener('change', () => { paused = reduced.matches; updatePause(); });
  updatePause();
})();
