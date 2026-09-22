// BACKBOARD PATCH: data-only polyline input; no generated JavaScript is executed.
async function(input, fitDrawing = false) {
    const doc = this.ownerDocument, win = doc.defaultView;
    if (this.tagName !== 'CANVAS' || !this.isConnected) return false;
    const rect = this.getBoundingClientRect();
    if (rect.width < 32 || rect.height < 32) return false;
    const strokes = fitDrawing ? input : [input];
    const first = strokes[0][0];
    // Move off the previously clicked tool before testing the stroke. Its
    // hover tooltip can cover the canvas until it receives mouseleave.
    const hoverKey = Symbol.for('cua-driver.synthetic-hover-target');
    const previous = doc[hoverKey];
    if (previous && previous !== this && previous.isConnected) {
        for (const type of ['pointerout','pointerleave','mouseout','mouseleave']) {
            const options = {bubbles:!type.endsWith('leave'),cancelable:true,composed:true,view:win,
                clientX:rect.left + first[0]*rect.width,clientY:rect.top + first[1]*rect.height,buttons:0,pointerId:1,pointerType:'mouse',isPrimary:true,relatedTarget:this};
            previous.dispatchEvent(type.startsWith('pointer') ? new win.PointerEvent(type,options) : new win.MouseEvent(type,options));
        }
        await new Promise(resolve => win.setTimeout(resolve, 50));
    }
    doc[hoverKey] = this;
    const unobstructed = ([x,y]) => x >= 0 && y >= 0 && x < win.innerWidth && y < win.innerHeight && doc.elementFromPoint(x,y) === this;
    const clearPath = path => path.every((point, i) => {
        if (!unobstructed(point)) return false;
        if (!i) return true;
        const before = path[i-1];
        const steps = Math.ceil(Math.hypot(point[0]-before[0], point[1]-before[1]) / 4);
        for (let n=1; n<steps; n++) {
            if (!unobstructed([before[0]+(point[0]-before[0])*n/steps, before[1]+(point[1]-before[1])*n/steps])) return false;
        }
        return true;
    });
    // A drawing canvas may include workspace margins and floating editor UI.
    // Fit the WHOLE plan once, with margins, preserving its proportions. Check
    // every stroke before drawing any of them, never move strokes independently.
    let paths;
    for (const scale of (fitDrawing ? [0.7, 0.6, 0.5, 0.4] : [1])) {
        const candidate = strokes.map(points => points.map(([x,y]) => [rect.left + rect.width*(0.5+(x-0.5)*scale), rect.top + rect.height*(0.5+(y-0.5)*scale)]));
        if (candidate.every(clearPath)) { paths = candidate; break; }
    }
    if (!paths) return false;
    const validate = point => {
        if (!this.isConnected) throw new Error('Canvas disconnected during drawing; some strokes may have landed');
        const current = this.getBoundingClientRect();
        if (current.x !== rect.x || current.y !== rect.y || current.width !== rect.width || current.height !== rect.height) throw new Error('Canvas moved during drawing; some strokes may have landed');
        if (!unobstructed(point)) throw new Error('Canvas became obstructed during drawing; some strokes may have landed');
    };
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
    try {
        for (const path of paths) {
            let point = path[0];
            validate(point);
            try {
                event('pointermove', point, 0); event('mousemove', point, 0);
                event('pointerdown', point, 1); event('mousedown', point, 1);
                for (const next of path.slice(1)) {
                    validate(next);
                    point = next;
                    event('pointermove', point, 1); event('mousemove', point, 1);
                    await new Promise(resolve => win.setTimeout(resolve, 8));
                }
            } finally {
                event('pointerup', point, 0); event('mouseup', point, 0);
            }
        }
    } finally {
        captures.forEach((name,i) => {
            if (descriptors[i]) Object.defineProperty(this, name, descriptors[i]);
            else delete this[name];
        });
    }
    return true;
}
