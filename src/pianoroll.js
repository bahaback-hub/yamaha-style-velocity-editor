/**
 * Canvas piano roll.
 *
 * Drawn on canvas rather than built from elements. A single exported style holds
 * four thousand-odd notes; as DOM nodes that is thousands of elements to lay out
 * on every pan frame, and dragging a velocity bar would stutter. Canvas draws
 * the visible window only, so cost scales with what is on screen.
 *
 * The view is deliberately one part at a time. Each channel in these exports is
 * a different instrument with its own pitch range - MainDrum sits in C2-C6 while
 * NylonGtr sits in E4-F#8 - so overlaying them would waste most of the vertical
 * space and produce overlap that means nothing.
 *
 * Coordinates are the whole contract here: pixels to ticks and back must be exact
 * in both directions, or a dragged note lands on the wrong tick. `tickToX` and
 * `xToTick` are the only places that know about scale.
 */

/** Minimum drawn note width, in CSS pixels, so a 16-tick hit is still clickable. */
const MIN_NOTE_PX = 3;

/** Gap above the top pitch row, so a top-row note is not flush to the edge. */
const PITCH_TOP = 6;

export class PianoRoll {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{onSelect?: (note: any) => void, onEdit?: (note: any, patch: {velocity?: number, pitch?: number}) => void, onSeek?: (tick: number) => void}} [handlers]
   */
  constructor(canvas, handlers = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.handlers = handlers;

    /** @type {any[]} */
    this.notes = [];
    /** @type {{name: string, family: string, color: string}|null} */
    this.part = null;
    this.division = 480;
    this.ticksPerBar = 1920;
    this.lengthTicks = 0;

    // View state: pixels per tick horizontally, pixels per semitone vertically.
    this.pxPerTick = 0.08;
    this.pxPerSemitone = 11;
    this.scrollTick = 0;
    this.scrollPitch = 60;

    this.selected = null;
    this.drag = null;
    this.hover = null;
    this.playheadTick = null;
    /** Grid snap in ticks; 0 disables snapping. */
    this.snap = 0;
    /** @type {Map<number, number>} note velocity overrides, keyed by velocityOffset */
    this.overrides = new Map();
    /**
     * Pending pitch and length, keyed by velocityOffset.
     *
     * Held as overrides rather than written into the note, for the same reason the
     * velocity is: the note objects belong to the parse of the file, and the
     * caller has to be able to tell what the file said from what the user has
     * done since. Mutating a note in place destroys that distinction - an edit
     * then looks like it matches the original and gets dropped.
     *
     * @type {Map<number, {pitch?: number, durationTicks?: number}>}
     */
    this.shapeOverrides = new Map();

    this.theme = {
      bg: '#11151b',
      gridBar: '#2c3542',
      gridBeat: '#20272f',
      row: '#161c24',
      rowAlt: '#131920',
      black: '#0b0e12',
      white: '#e8edf3',
      dim: '#6b7885',
      outline: 'rgba(255,255,255,0.22)',
    };

    this.resize();
    this.#bindEvents();
  }

  // ---- coordinate mapping ---------------------------------------------------

  get cssWidth() { return this.canvas.clientWidth || 1; }
  get cssHeight() { return this.canvas.clientHeight || 1; }

  /** Ticks per CSS pixel. */
  get tickScale() { return 1 / this.pxPerTick; }

  /** Horizontal: an absolute tick to a canvas x. */
  tickToX(tick) {
    return (tick - this.scrollTick) * this.pxPerTick;
  }

  /** Horizontal: a canvas x back to an absolute tick, snapped if snapping is on. */
  xToTick(x, snap = this.snap) {
    const raw = this.scrollTick + x / this.pxPerTick;
    return snap > 0 ? Math.round(raw / snap) * snap : Math.round(raw);
  }

  /**
   * Vertical: a MIDI note number to a canvas y. Higher pitch is higher up.
   *
   * `scrollPitch` is the pitch drawn at the top edge, so it plays the role of a
   * scroll origin rather than a scroll offset.
   */
  pitchToY(note) {
    return (this.scrollPitch - note) * this.pxPerSemitone + PITCH_TOP;
  }

  /** Vertical: a canvas y back to a MIDI note number. */
  yToPitch(y) {
    const note = this.scrollPitch - (y - PITCH_TOP) / this.pxPerSemitone;
    return Math.max(0, Math.min(127, Math.round(note)));
  }

  /** The pitch range drawn, derived from the part so it fills the height. */
  get pitchRange() {
    if (this.notes.length === 0) return { low: 36, high: 72 };
    let low = 127;
    let high = 0;
    for (const n of this.notes) {
      const pitch = this.pitchOf(n);
      if (pitch < low) low = pitch;
      if (pitch > high) high = pitch;
    }
    // A few semitones of headroom, not two octaves. Padding generously looks
    // reasonable on a part that fills the screen and wastes a third of the height
    // on a sparse one, where the rows end up too thin to aim a drag at.
    return { low: Math.max(0, low - 3), high: Math.min(127, high + 3) };
  }

  /** Zoom to fit the whole part, which is what a first load should show. */
  fit() {
    const { low, high } = this.pitchRange;
    const rows = Math.max(1, high - low);
    // Capped so a part with a handful of notes does not end up with rows so tall
    // that a single note fills the screen.
    this.pxPerSemitone = Math.max(4, Math.min(20, (this.cssHeight - 12) / rows));
    // Open on the part's first note, not on tick 0. In a real export a channel can
    // stay silent for most of the file - the drums here do not sound until well
    // past the halfway point - so scrolling to zero would present an empty grid and
    // leave the user with nothing to grab.
    this.scrollTick = Math.max(0, this.firstTick() - this.ticksPerBar / 4);
    this.scrollPitch = high;
    this.clampScroll();
  }

  /** The earliest note in the part, or 0 when the part is empty. */
  firstTick() {
    let first = Infinity;
    for (const n of this.notes) if (n.at < first) first = n.at;
    return first === Infinity ? 0 : first;
  }

  /** Zoom horizontally around a canvas x so the point under the cursor stays put. */
  zoomAt(x, factor) {
    const anchor = this.xToTick(x, 0);
    this.pxPerTick = Math.max(0.004, Math.min(6, this.pxPerTick * factor));
    this.scrollTick = anchor - x / this.pxPerTick;
    // Only the horizontal clamp applies here. clampScroll also bounds the
    // vertical origin against the note range, which does not depend on the
    // horizontal zoom at all, and letting it run would drift the view for reasons
    // the user did not ask for.
    this.scrollTick = Math.max(-this.pxPerTick * 4, Math.min(this.lengthTicks, this.scrollTick));
  }

  zoomVertical(factor) {
    const centreNote = this.yToPitch(this.cssHeight / 2);
    this.pxPerSemitone = Math.max(3, Math.min(40, this.pxPerSemitone * factor));
    this.scrollPitch = this.#clampPitchOrigin(centreNote + (this.cssHeight / 2 - PITCH_TOP) / this.pxPerSemitone);
  }

  clampScroll() {
    this.scrollTick = Math.max(-this.pxPerTick * 4, Math.min(this.lengthTicks, this.scrollTick));
    this.scrollPitch = this.#clampPitchOrigin(this.scrollPitch);
  }

  /**
   * Bound the top-edge pitch so the visible window stays over real notes.
   *
   * `scrollPitch` is the pitch drawn at the top, so the window reaches down to
   * `scrollPitch - visible`. That gives two bounds: never above the highest note,
   * and never so low that the lowest note is above the bottom edge - which is
   * `low + visible`. When the window is taller than the range itself the two
   * collapse and the view simply pins to the top note.
   *
   * Written the other way round - nesting a min inside a max - these bounds
   * invert and the view snaps to the top of the part on every zoom.
   */
  #clampPitchOrigin(value) {
    const { low, high } = this.pitchRange;
    const visible = this.cssHeight / this.pxPerSemitone;
    const minTop = Math.min(high, low + visible);
    return Math.min(high, Math.max(minTop, value));
  }

  /** Scroll so a tick is visible, used when playback starts. */
  revealTick(tick) {
    const x = this.tickToX(tick);
    if (x < 0 || x > this.cssWidth * 0.8) {
      this.scrollTick = Math.max(0, tick - this.cssWidth * 0.15 / this.pxPerTick);
      this.clampScroll();
    }
  }

  // ---- data -----------------------------------------------------------------

  /**
   * @param {any[]} notes only the notes of the part being shown
   * @param {{name: string, family: string, color: string}|null} part
   */
  setNotes(notes, part, timing) {
    this.notes = notes;
    this.part = part;
    this.division = timing.division || 480;
    this.ticksPerBar = timing.ticksPerBar || 1920;
    this.lengthTicks = timing.lengthTicks || 0;
    this.selected = null;
    this.hover = null;
    this.fit();
  }

  setOverrides(map) {
    this.overrides = map ?? new Map();
  }

  setShapeOverrides(map) {
    this.shapeOverrides = map ?? new Map();
  }

  /** The velocity to draw for a note, honouring any pending edit. */
  velocityOf(note) {
    return this.overrides.get(note.velocityOffset) ?? note.velocity;
  }

  /** The pitch to draw for a note, honouring any pending retune. */
  pitchOf(note) {
    return this.shapeOverrides.get(note.velocityOffset)?.pitch ?? note.note;
  }

  /** The length to draw for a note, honouring any pending resize. */
  durationOf(note) {
    return this.shapeOverrides.get(note.velocityOffset)?.durationTicks ?? note.durationTicks;
  }

  /** Record a pending shape change without touching the note itself. */
  #shape(note, change) {
    const current = this.shapeOverrides.get(note.velocityOffset) ?? {};
    this.shapeOverrides.set(note.velocityOffset, { ...current, ...change });
  }

  /** Notes intersecting the visible window, in draw order. */
  visibleNotes() {
    const from = this.xToTick(0, 0) - this.ticksPerBar;
    const to = this.xToTick(this.cssWidth, 0) + this.ticksPerBar;
    const { low, high } = this.pitchRange;
    return this.notes.filter((n) => {
      const pitch = this.pitchOf(n);
      return n.at + Math.max(1, this.durationOf(n)) >= from && n.at <= to
        && pitch >= low && pitch <= high;
    });
  }

  /** The note under a canvas point, if any. Nearest wins on small targets. */
  noteAt(x, y) {
    const pitch = this.yToPitch(y);
    let best = null;
    let bestDx = Infinity;
    for (const n of this.visibleNotes()) {
      if (this.pitchOf(n) !== pitch) continue;
      const nx = this.tickToX(n.at);
      const nw = Math.max(MIN_NOTE_PX, this.durationOf(n) * this.pxPerTick);
      if (x >= nx - 2 && x <= nx + nw + 2) {
        const dx = Math.abs(x - nx);
        if (dx < bestDx) { bestDx = dx; best = n; }
      }
    }
    return best;
  }

  /**
   * The note whose trailing edge is under a canvas point.
   *
   * Length is edited from the right edge rather than by dragging the body, so the
   * body can stay reserved for retuning. The handle is deliberately wider than it
   * looks - three pixels is precise on a 4K display and unusable on a laptop
   * trackpad, and every DAW widens its resize zone well past the drawn border.
   *
   * @returns {{note: any, edgeX: number}|null}
   */
  lengthHandleAt(x, y) {
    const pitch = this.yToPitch(y);
    const grab = Math.max(4, MIN_NOTE_PX);
    let best = null;
    let bestDx = Infinity;
    for (const n of this.visibleNotes()) {
      if (this.pitchOf(n) !== pitch) continue;
      const nx = this.tickToX(n.at);
      const nw = Math.max(MIN_NOTE_PX, this.durationOf(n) * this.pxPerTick);
      const dx = Math.abs(x - (nx + nw));
      if (dx <= grab && dx < bestDx) { bestDx = dx; best = { note: n, edgeX: nx + nw }; }
    }
    return best;
  }

  // ---- rendering ------------------------------------------------------------

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (!w || !h) return;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  draw() {
    const { ctx } = this;
    const w = this.cssWidth;
    const h = this.cssHeight;
    const { low, high } = this.pitchRange;
    const color = this.part?.color ?? '#e8a33d';
    const beat = this.ticksPerBar / (this.pxPerTick > 0.02 ? 4 : 1);

    ctx.fillStyle = this.theme.bg;
    ctx.fillRect(0, 0, w, h);

    // Pitch rows, black-key rows darker.
    const firstRow = Math.floor(this.yToPitch(h));
    for (let n = firstRow; n <= high + 1; n++) {
      if (n < low) continue;
      const y = this.pitchToY(n);
      const isBlack = [1, 3, 6, 8, 10].includes(n % 12);
      ctx.fillStyle = isBlack ? this.theme.black : (n % 12 === 0 ? '#1b222c' : this.theme.row);
      ctx.fillRect(0, y, w, this.pxPerSemitone);
    }

    // Vertical grid: beats when zoomed in, bars when zoomed out.
    const beatPx = beat * this.pxPerTick;
    if (beatPx >= 5) {
      ctx.strokeStyle = this.theme.gridBeat;
      ctx.lineWidth = 1;
      ctx.beginPath();
      const fromBeat = Math.floor(this.xToTick(0, 0) / beat) * beat;
      for (let t = fromBeat; this.tickToX(t) < w; t += beat) {
        const x = Math.round(this.tickToX(t)) + 0.5;
        ctx.moveTo(x, 0); ctx.lineTo(x, h);
      }
      ctx.stroke();
    }
    ctx.strokeStyle = this.theme.gridBar;
    ctx.beginPath();
    const fromBar = Math.floor(this.xToTick(0, 0) / this.ticksPerBar) * this.ticksPerBar;
    for (let t = fromBar; this.tickToX(t) < w; t += this.ticksPerBar) {
      const x = Math.round(this.tickToX(t)) + 0.5;
      ctx.moveTo(x, 0); ctx.lineTo(x, h);
    }
    ctx.stroke();

    // Notes.
    for (const n of this.visibleNotes()) {
      const x = this.tickToX(n.at);
      const nw = Math.max(MIN_NOTE_PX, this.durationOf(n) * this.pxPerTick);
      const y = this.pitchToY(this.pitchOf(n));
      const nh = Math.max(2, this.pxPerSemitone - 1);
      const v = this.velocityOf(n) / 127;
      const isSel = this.selected && this.selected.velocityOffset === n.velocityOffset;
      const isHover = this.hover && this.hover.velocityOffset === n.velocityOffset;

      ctx.fillStyle = color;
      ctx.globalAlpha = 0.28 + 0.62 * v;
      ctx.fillRect(x, y, nw, nh);
      ctx.globalAlpha = 1;

      if (isSel || isHover) {
        ctx.strokeStyle = isSel ? '#ffffff' : this.theme.outline;
        ctx.lineWidth = isSel ? 2 : 1;
        ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(nw) - 1, Math.round(nh) - 1);
      }
      // A resize tab on the selected note, so it is discoverable that the edge is
      // draggable rather than just a border.
      if (isSel && nw >= 6) {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(Math.round(x + nw) - 2, Math.round(y) + 1, 2, Math.max(2, nh - 2));
      }
      // Velocity readout on the selected note only, so the grid stays clean.
      if (isSel && nw > 26) {
        ctx.fillStyle = '#0b0e12';
        ctx.font = '9px ui-monospace, monospace';
        ctx.textAlign = 'center';
        ctx.fillText(String(this.velocityOf(n)), x + nw / 2, y + nh / 2 + 3);
      }
    }

    // Pitch labels down the right edge, drawn after the notes and each on its own
    // backing: a long note runs to the edge of the canvas and would otherwise
    // cover the very labels needed to read its row.
    if (this.pxPerSemitone >= 7) {
      ctx.font = '10px ui-monospace, monospace';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      // Below this row height there is no room for a number on every semitone, so
      // only the octaves are labelled - which is what makes it readable anyway.
      const everySemitone = this.pxPerSemitone >= 11;
      for (let n = low; n <= high; n++) {
        if (!everySemitone && n % 12 !== 0) continue;
        const y = this.pitchToY(n) + this.pxPerSemitone / 2;
        const text = String(n);
        const tw = ctx.measureText(text).width;
        ctx.fillStyle = 'rgba(11,14,18,0.78)';
        ctx.fillRect(w - tw - 7, y - this.pxPerSemitone / 2 + 1, tw + 6, Math.max(9, this.pxPerSemitone - 2));
        ctx.fillStyle = n % 12 === 0 ? '#9aa7b4' : 'rgba(139,152,165,0.75)';
        ctx.fillText(text, w - 4, y);
      }
    }

    if (this.playheadTick != null) {
      const x = this.tickToX(this.playheadTick);
      if (x >= 0 && x <= w) {
        ctx.strokeStyle = '#e8a33d';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(Math.round(x) + 0.5, 0);
        ctx.lineTo(Math.round(x) + 0.5, h);
        ctx.stroke();
      }
    }
  }

  // ---- interaction ----------------------------------------------------------

  #pos(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  #bindEvents() {
    const c = this.canvas;

    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const { x } = this.#pos(e);
      if (e.shiftKey) this.zoomVertical(e.deltaY < 0 ? 1.15 : 1 / 1.15);
      else this.zoomAt(x, e.deltaY < 0 ? 1.2 : 1 / 1.2);
      this.draw();
    }, { passive: false });

    c.addEventListener('pointerdown', (e) => {
      const { x, y } = this.#pos(e);
      const note = this.noteAt(x, y);
      // The resize edge wins over the body, otherwise a short note is unresizable
      // because its own note hitbox swallows the whole edge.
      const handle = this.lengthHandleAt(x, y);
      if (note && handle && handle.note === note) {
        this.selected = note;
        this.drag = { kind: 'length', note };
        this.handlers.onSelect?.(note);
      } else if (note) {
        this.selected = note;
        this.drag = { kind: 'pitch', note };
        this.handlers.onSelect?.(note);
      } else {
        this.selected = null;
        this.drag = { kind: 'pan', startX: x, startScroll: this.scrollTick };
        this.handlers.onSelect?.(null);
      }
      c.setPointerCapture(e.pointerId);
      this.draw();
    });

    c.addEventListener('pointermove', (e) => {
      const { x, y } = this.#pos(e);
      if (!this.drag) {
        const n = this.noteAt(x, y);
        const changed = (n?.velocityOffset ?? null) !== (this.hover?.velocityOffset ?? null);
        const overEdge = this.lengthHandleAt(x, y) !== null;
        this.hover = n;
        c.style.cursor = overEdge ? 'ew-resize' : n ? 'ns-resize' : 'grab';
        if (changed) this.draw();
        return;
      }
      if (this.drag.kind === 'pan') {
        this.scrollTick = this.drag.startScroll - (x - this.drag.startX) / this.pxPerTick;
        this.clampScroll();
      } else if (this.drag.kind === 'pitch') {
        const pitch = this.yToPitch(y);
        if (pitch !== this.pitchOf(this.drag.note)) {
          this.#shape(this.drag.note, { pitch });
          this.handlers.onEdit?.(this.drag.note, { pitch });
        }
      } else if (this.drag.kind === 'length') {
        // One tick is the floor: a zero-length note has no release to move, and
        // writing one would mean inserting an event mid-gesture.
        const end = this.xToTick(x);
        const next = Math.max(1, end - this.drag.note.at);
        if (next !== this.durationOf(this.drag.note)) {
          this.#shape(this.drag.note, { durationTicks: next });
          this.handlers.onEdit?.(this.drag.note, { durationTicks: next });
        }
      }
      this.draw();
    });

    const end = (e) => {
      if (this.drag) {
        try { c.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
        if (this.drag.kind === 'length' || this.drag.kind === 'pitch') {
          this.handlers.onCommit?.();
        }
        this.drag = null;
      }
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);

    c.addEventListener('dblclick', (e) => {
      // Double click seeks, which is how every DAW behaves.
      const { x, y } = this.#pos(e);
      this.handlers.onSeek?.(this.xToTick(x));
    });
  }

  setPlayhead(tick) {
    this.playheadTick = tick;
  }
}

