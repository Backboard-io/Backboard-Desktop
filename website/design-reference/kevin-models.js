(() => {
 const slider = document.querySelector('.model-slider');
 if (!slider) return;
 const items = [...slider.querySelectorAll('.model-slide')];
 const previous = document.querySelector('[data-slide="prev"]');
 const next = document.querySelector('[data-slide="next"]');
 const playback = document.querySelector('.model-playback');
 const range = document.querySelector('.model-range');
 const reduced = matchMedia('(prefers-reduced-motion: reduce)');
 let paused = reduced.matches;
 let hovered = false;
 let focused = false;
 let visible = false;
 let resumeAt = 0;
 let direction = 1;
 let frame = 0;
 let lastTime = 0;
 let position = slider.scrollLeft;
 let lastUpdate = 0;
 const maximum = () => slider.scrollWidth - slider.clientWidth;
 function update() {
  const bounds = slider.getBoundingClientRect();
  const visibleItems = items.map((item, i) => ({i, r:item.getBoundingClientRect()}))
   .filter(({r}) => r.right > bounds.left + 8 && r.left < bounds.right - 8);
  range.textContent = `${(visibleItems[0]?.i ?? 0) + 1}–${(visibleItems.at(-1)?.i ?? items.length - 1) + 1} / ${items.length}`;
  previous.disabled = slider.scrollLeft < 2;
  next.disabled = slider.scrollLeft >= maximum() - 2;
 }
 function renderPlayback() {
  playback.innerHTML = paused ? '▶ <span>Play</span>' : 'Ⅱ <span>Pause</span>';
  playback.setAttribute('aria-label', paused ? 'Play model slider' : 'Pause model slider');
 }
 function tick(time) {
  const elapsed = Math.min(time - lastTime, 50);
  lastTime = time;
  if (time >= resumeAt) {
   // Retain fractional movement so subpixel frames do not stall at high refresh rates.
   position += direction * elapsed * .04;
   if (position >= maximum()) { position = maximum(); direction = -1; }
   if (position <= 0) { position = 0; direction = 1; }
   slider.scrollLeft = position;
   if (time - lastUpdate > 180) { update(); lastUpdate = time; }
  } else position = slider.scrollLeft;
  frame = requestAnimationFrame(tick);
 }
 function syncMotion() {
  cancelAnimationFrame(frame);
  if (!paused && !hovered && !focused && visible && !document.hidden) {
   position = slider.scrollLeft;
   lastTime = performance.now();
   frame = requestAnimationFrame(tick);
  }
 }
 function move(left) {
  resumeAt = performance.now() + 5000;
  slider.scrollTo({left:Math.max(0, Math.min(maximum(), left)), behavior:reduced.matches ? 'instant' : 'smooth'});
 }
 previous.addEventListener('click', () => move(slider.scrollLeft - slider.clientWidth * .8));
 next.addEventListener('click', () => move(slider.scrollLeft + slider.clientWidth * .8));
 playback.addEventListener('click', () => { paused = !paused; renderPlayback(); syncMotion(); });
 slider.addEventListener('pointerenter', event => { if (event.pointerType === 'mouse') { hovered = true; syncMotion(); } });
 slider.addEventListener('pointerleave', () => { hovered = false; syncMotion(); });
 slider.addEventListener('focusin', () => { focused = true; syncMotion(); });
 slider.addEventListener('focusout', () => { focused = false; syncMotion(); });
 const delayMotion = () => { resumeAt = performance.now() + 5000; };
 slider.addEventListener('pointerdown', delayMotion, {passive:true});
 slider.addEventListener('touchmove', delayMotion, {passive:true});
 slider.addEventListener('wheel', delayMotion, {passive:true});
 slider.addEventListener('keydown', event => {
  const gap = parseFloat(getComputedStyle(slider.querySelector('ul')).gap);
  const step = items[0].getBoundingClientRect().width + gap;
  const positions = {ArrowRight:slider.scrollLeft + step, ArrowLeft:slider.scrollLeft - step, Home:0, End:maximum()};
  if (event.key in positions) { event.preventDefault(); move(positions[event.key]); }
 });
 let scrollFrame;
 slider.addEventListener('scroll', () => { cancelAnimationFrame(scrollFrame); scrollFrame = requestAnimationFrame(update); }, {passive:true});
 new ResizeObserver(() => { position = slider.scrollLeft; update(); }).observe(slider);
 new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; syncMotion(); }).observe(slider);
 document.addEventListener('visibilitychange', syncMotion);
 reduced.addEventListener('change', () => { paused = reduced.matches; renderPlayback(); syncMotion(); });
 renderPlayback(); update();
})();
