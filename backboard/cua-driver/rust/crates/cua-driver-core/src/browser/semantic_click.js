// BACKBOARD PATCH: full synthetic click sequence for custom DOM controls.
function() {
    const doc = this.ownerDocument, win = doc.defaultView;
    if (!this.isConnected || this.disabled || this.getAttribute('aria-disabled') === 'true') return false;
    const r = this.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const x = Math.max(0, r.left) + (Math.min(win.innerWidth, r.right) - Math.max(0, r.left)) / 2;
    const y = Math.max(0, r.top) + (Math.min(win.innerHeight, r.bottom) - Math.max(0, r.top)) / 2;
    const hit = doc.elementFromPoint(x, y);
    if (!hit || (hit !== this && !this.contains(hit))) return false;
    const o = {bubbles:true,cancelable:true,composed:true,view:win,clientX:x,clientY:y,button:0,pointerId:1,pointerType:'mouse',isPrimary:true};
    // A synthetic pointer has no browser-managed hover transitions. Keep its
    // last target so moving to another control or canvas clears hover UI.
    const hoverKey = Symbol.for('cua-driver.synthetic-hover-target');
    const previous = doc[hoverKey];
    if (previous && previous !== this && previous.isConnected) {
        for (const type of ['pointerout','pointerleave','mouseout','mouseleave']) {
            const options = {...o, buttons:0, relatedTarget:this, bubbles:!type.endsWith('leave')};
            previous.dispatchEvent(type.startsWith('pointer') ? new win.PointerEvent(type,options) : new win.MouseEvent(type,options));
        }
    }
    doc[hoverKey] = this;
    for (const type of ['pointerover','pointerenter','mouseover','mouseenter','pointermove','mousemove','pointerdown','mousedown','pointerup','mouseup']) {
        const options = {...o, buttons:type.endsWith('down') ? 1 : 0, bubbles:!type.endsWith('enter')};
        this.dispatchEvent(type.startsWith('pointer') ? new win.PointerEvent(type,options) : new win.MouseEvent(type,options));
    }
    if (typeof this.click === "function") this.click();
    else this.dispatchEvent(new win.MouseEvent("click", {...o, buttons:0}));
    return true;
}
