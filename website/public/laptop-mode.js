window.addEventListener('message', event => {
  if(event.origin !== location.origin || event.source !== parent) return;
  if(event.data?.type === 'laptop-mode' && ['simple','editor','advanced'].includes(event.data.mode)) {
    renderMode(event.data.mode, {manual:true});
  }
});
