(() => {
 const viewport=document.querySelector('.demo-viewport');
 const screen=viewport.querySelector('.computer-screen');
 const frame=viewport.querySelector('iframe');
 const film=viewport.querySelector('video');
 const buttons=[...document.querySelectorAll('[data-mode]')];
 const descriptions={film:'A glimpse of what you can make.',simple:'A thought, a conversation, a place to begin.',editor:'Your files and tools, with an agent right beside you.',advanced:'More ideas in motion. Keep the whole picture in view.'};
 let mode='simple';
 const sendMode=()=>{if(mode!=='film')frame.contentWindow.postMessage({type:'laptop-mode',mode},location.origin)};
 const resize=()=>frame.style.transform=`scale(${screen.clientWidth/1100},${screen.clientHeight/720})`;
 new ResizeObserver(resize).observe(viewport);resize();frame.addEventListener('load',sendMode);
 const select=next=>{
  mode=next;frame.hidden=mode==='film';film.hidden=mode!=='film';
  if(mode==='film')film.play().catch(()=>{});else film.pause();
  sendMode();buttons.forEach(item=>item.setAttribute('aria-pressed',String(item.dataset.mode===mode)));
  document.querySelector('#mode-description').textContent=descriptions[mode];
 };
 buttons.forEach(button=>button.addEventListener('click',()=>select(button.dataset.mode)));
 document.querySelectorAll('[data-jump-mode]').forEach(link=>link.addEventListener('click',()=>select(link.dataset.jumpMode)));
 new IntersectionObserver(([entry])=>{if(!entry.isIntersecting)film.pause()}).observe(viewport);
 document.addEventListener('visibilitychange',()=>{if(document.hidden)film.pause()});
})();
