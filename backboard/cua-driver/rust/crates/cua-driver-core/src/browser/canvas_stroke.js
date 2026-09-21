// BACKBOARD PATCH: data-only polyline input; no generated JavaScript is executed.
async function(points) {
    const doc = this.ownerDocument, win = doc.defaultView;
    if (this.tagName !== 'CANVAS' || !this.isConnected) return false;
    const rect = this.getBoundingClientRect();
    if (rect.width < 32 || rect.height < 32) return false;
    const path = points.map(([x, y]) => [rect.left + x * rect.width, rect.top + y * rect.height]);
    // Refuse before sending any input if a toolbar/dialog covers any stroke point.
    if (path.some(([x,y]) => x < 0 || y < 0 || x >= win.innerWidth || y >= win.innerHeight || doc.elementFromPoint(x,y) !== this)) return false;
    const event = (type, point, buttons) => {
        const options = { bubbles: true, cancelable: true, composed: true, view: win,
            clientX: point[0], clientY: point[1], button: type.endsWith('move') ? -1 : 0,
            buttons, pointerId: 1, pointerType: 'mouse', isPrimary: true, pressure: buttons ? 0.5 : 0 };
        this.dispatchEvent(type.startsWith('pointer') ? new win.PointerEvent(type, options) : new win.MouseEvent(type, {...options, button: 0}));
    };
    // Synthetic pointer ids are not registered with Chromium. Emulate capture
    // for this one gesture on this one target; preserve all other pointers and
    // restore the exact original own properties even when a handler fails.
    const captures = ['setPointerCapture', 'releasePointerCapture', 'hasPointerCapture'];
    const descriptors = captures.map(name => Object.getOwnPropertyDescriptor(this, name));
    let captured = false;
    for (const name of captures) {
        const original = this[name];
        Object.defineProperty(this, name, {configurable:true, value: id => {
            if (id !== 1) return original.call(this, id);
            if (name === 'hasPointerCapture') return captured;
            captured = name === 'setPointerCapture';
        }});
    }
    let point = path[0];
    try {
        event('pointermove', point, 0); event('mousemove', point, 0);
        event('pointerdown', point, 1); event('mousedown', point, 1);
        for (const next of path.slice(1)) {
            if (!this.isConnected) throw new Error('Canvas disconnected during stroke');
            const current = this.getBoundingClientRect();
            if (current.x !== rect.x || current.y !== rect.y || current.width !== rect.width || current.height !== rect.height) throw new Error('Canvas moved during stroke');
            point = next;
            event('pointermove', point, 1); event('mousemove', point, 1);
            await new Promise(resolve => win.setTimeout(resolve, 8));
        }
    } finally {
        try {
            event('pointerup', point, 0); event('mouseup', point, 0);
        } finally {
            captures.forEach((name,i) => {
                if (descriptors[i]) Object.defineProperty(this, name, descriptors[i]);
                else delete this[name];
            });
        }
    }
    return true;
}
