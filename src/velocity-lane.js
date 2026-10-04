/**
 * Velocity lane: one draggable bar per note, under the piano roll.
 *
 * This is the gesture that makes the tool usable. Setting a value in a box and
 * applying it to a selection is fine for "make this whole part quieter"; it is
 * hopeless for shaping an accent, which is a per-note decision made by ear. The
 * lane turns velocity into something you can see and drag.
 *
 * Shares the piano roll's time scale so the two views line up exactly - a note
 * and its velocity bar must sit at the same x, or the pairing is unreadable.
 */

const MIN_H = 3;

export class VelocityLane {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{onEdit?: (note: any, patch: {velocity: number}) => void, onCommit?: () => void, onSelect?: (note: any) => void, onSeek?: (number) => void}} [handlers]
   */
  constructor(canvas, handlers = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.handlers = handlers;

    /** @type {any[]} */
    this.notes = [];
    this.part = null;
    this.ticksPerBar = 1920;
    this.scrollTick = 0;
    this.pxPerTick = 0.08;
    this.overrides = new Map();
    /**
     * Pending length changes, keyed by velocityOffset, so a bar drawn under a note
     * grows with it. A lane that ignored a resize would show the pairing drifting
     * out of step with the roll above.
     * @type {Map<number, {durationTicks?: number}>}
     */
    this.shapeOverrides = new Map();

    this.selected = null;
    this.hover = null;
    this.drag = null;
    this.playheadTick = null;
    /** Uniform offset applied while dragging, so the whole gesture is relative. */
    this.snap = 0;

    this.theme = { bg: '#0d1116', grid: '#222a33', bar: '#4ec9a0', dim: '#6b7885' };

    this.resize();
    this.#bindEvents();
  }

  get cssWidth() { return this.canvas.clientWidth || 1; }
  get cssHeight() { return this.canvas.clientHeight || 1; }

  tickToX(tick) { return (tick - this.scrollTick) * this.pxPerTick; }
  xToTick(x) {
    const raw = this.scrollTick + x / this.pxPerTick;
    return this.snap > 0 ? Math.round(raw / this.snap) * this.snap : Math.round(raw);
  }

  /** Velocity 0-127 to a y. The lane is drawn top-down with 127 at the top. */
  velocityToY(v) {
    return ((127 - v) / 127) * (this.cssHeight - 8) + 4;
  }

  yToVelocity(y) {
    const v = 127 - ((y - 4) / Math.max(1, this.cssHeight - 8)) * 127;
    return Math.max(1, Math.min(127, Math.round(v)));
  }

  setNotes(notes, part, timing, view) {
    this.notes = notes;
    this.part = part;
    this.ticksPerBar = timing.ticksPerBar || 1920;
    if (view) {
      this.scrollTick = view.scrollTick;
      this.pxPerTick = view.pxPerTick;
    }
  }

  /** Follow the piano roll's scroll so the two stay aligned. */
  syncView(roll) {
    this.scrollTick = roll.scrollTick;
    this.pxPerTick = roll.pxPerTick;
  }

  setOverrides(map) { this.overrides = map ?? new Map(); }
  setShapeOverrides(map) { this.shapeOverrides = map ?? new Map(); }
  velocityOf(note) { return this.overrides.get(note.velocityOffset) ?? note.velocity; }
  durationOf(note) { return this.shapeOverrides.get(note.velocityOffset)?.durationTicks ?? note.durationTicks; }

  visibleNotes() {
    const from = this.xToTick(0) - this.ticksPerBar;
    const to = this.xToTick(this.cssWidth) + this.ticksPerBar;
    return this.notes.filter((n) => n.at + Math.max(1, this.durationOf(n)) >= from && n.at <= to);
  }

  noteAt(x) {
    let best = null;
    let bestDx = Infinity;
    for (const n of this.visibleNotes()) {
      const nx = this.tickToX(n.at);
      const dx = Math.abs(x - nx);
      if (dx <= 5 && dx < bestDx) { bestDx = dx; best = n; }
    }
    return best;
  }

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
    const color = this.part?.color ?? '#4ec9a0';

    ctx.fillStyle = this.theme.bg;
    ctx.fillRect(0, 0, w, h);

    // Bar lines, matching the roll.
    ctx.strokeStyle = this.theme.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    const fromBar = Math.floor(this.xToTick(0) / this.ticksPerBar) * this.ticksPerBar;
    for (let t = fromBar; this.tickToX(t) < w; t += this.ticksPerBar) {
      const x = Math.round(this.tickToX(t)) + 0.5;
      ctx.moveTo(x, 0); ctx.lineTo(x, h);
    }
    ctx.stroke();

    // Velocity scale hints: the grid lines with a number on each.
    ctx.font = '9px ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    for (const v of [127, 100, 64, 32]) {
      const y = this.velocityToY(v);
      ctx.fillStyle = 'rgba(107,120,133,0.5)';
      ctx.fillText(String(v), 4, y + 1);
      ctx.strokeStyle = 'rgba(34,42,51,0.9)';
      ctx.beginPath();
      ctx.moveTo(0, Math.round(y) + 0.5);
      ctx.lineTo(w, Math.round(y) + 0.5);
      ctx.stroke();
    }

    for (const n of this.visibleNotes()) {
      const x = this.tickToX(n.at);
      if (x < -4 || x > w + 4) continue;
      const v = this.velocityOf(n);
      const y = this.velocityToY(v);
      const isSel = this.selected && this.selected.velocityOffset === n.velocityOffset;
      const isHover = this.hover && this.hover.velocityOffset === n.velocityOffset;
      const bw = Math.max(1.5, Math.max(2, this.durationOf(n) * this.pxPerTick));

      ctx.fillStyle = color;
      ctx.globalAlpha = isSel ? 1 : isHover ? 0.9 : 0.62;
      ctx.fillRect(x - bw / 2, y, bw, Math.max(MIN_H, h - y - 2));
      ctx.globalAlpha = 1;

      if (isSel) {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(x - bw / 2 - 1, y - 1, bw + 2, 2);
      }
    }

    // Scale numbers again, on top of the bars. A quiet note draws a bar from its
    // own level all the way to the floor, which is exactly where the low numbers
    // sit - drawn first, they were simply erased by the thing they measure.
    ctx.font = '9px ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    for (const v of [127, 100, 64, 32]) {
      const y = this.velocityToY(v);
      const text = String(v);
      const tw = ctx.measureText(text).width;
      ctx.fillStyle = 'rgba(11,14,18,0.8)';
      ctx.fillRect(2, y + 1, tw + 4, 11);
      ctx.fillStyle = 'rgba(154,167,180,0.9)';
      ctx.fillText(text, 4, y + 2);
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

  #pos(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  #bindEvents() {
    const c = this.canvas;

    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.handlers.onSeek?.(this.xToTick(this.#pos(e).x));
      e.stopPropagation();
    }, { passive: false });

    c.addEventListener('pointerdown', (e) => {
      const { x, y } = this.#pos(e);
      const note = this.noteAt(x);
      if (note) {
        this.selected = note;
        // Capture the whole gesture as a delta from where it started, so the
        // note follows the pointer exactly instead of jumping to the cursor.
        this.drag = { note, startY: y, startVelocity: this.velocityOf(note), moved: false };
        this.handlers.onSelect?.(note);
      } else {
        this.selected = null;
        this.drag = { seek: true };
        this.handlers.onSelect?.(null);
        this.handlers.onSeek?.(this.xToTick(x));
      }
      c.setPointerCapture(e.pointerId);
      this.draw();
    });

    c.addEventListener('pointermove', (e) => {
      const { x, y } = this.#pos(e);
      if (!this.drag) {
        const n = this.noteAt(x);
        const changed = (n?.velocityOffset ?? null) !== (this.hover?.velocityOffset ?? null);
        this.hover = n;
        c.style.cursor = n ? 'ns-resize' : 'default';
        if (changed) this.draw();
        return;
      }
      if (this.drag.seek) return;
      const next = Math.max(1, Math.min(127, this.drag.startVelocity + Math.round((this.drag.startY - y) / 2)));
      const current = this.velocityOf(this.drag.note);
      if (next !== current) {
        this.drag.moved = true;
        this.handlers.onEdit?.(this.drag.note, { velocity: next });
        this.draw();
      }
    });

    const end = (e) => {
      if (this.drag && this.drag.moved) this.handlers.onCommit?.();
      if (this.drag) {
        try { c.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
        this.drag = null;
      }
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
  }

  setPlayhead(tick) { this.playheadTick = tick; }
}

/**
 * Velocity transforms.
 *
 * Every one of these is a pure function from an old velocity to a new one, so
 * they compose and they are trivially testable. That matters more than it looks:
 * "make it 15% louder" followed by "humanise" should mean the same thing as
 * running them in the other order, and a single test of each function pins that.
 */

/**
 * @param {number} v
 * @param {number} percent 100 leaves it alone, 200 doubles, 50 halves
 */
export function scaleVelocity(v, percent) {
  // percent is a percentage of the original, not a multiplier: 150% means one and
  // a half times. Dividing by 100 twice turns 150% into 0.67%, which quietly
  // collapses everything to the floor.
  return clamp((v * percent) / 100);
}

/** @param {number} v @param {number} amount signed */
export function offsetVelocity(v, amount) {
  return clamp(v + amount);
}

/** @param {number} v @param {number} spread peak deviation, 0 leaves it alone */
export function humanizeVelocity(v, spread, rng = Math.random) {
  if (spread <= 0) return v;
  // Triangular distribution: sums two uniforms, which clusters near the middle.
  // A flat random would push everything toward the extremes and destroy the
  // accent pattern the file was written with.
  const t = (rng() + rng() - 1) * spread;
  return clamp(Math.round(v + t));
}

/** Random within an explicit band, for deliberate re-writing rather than nudging. */
export function randomVelocity(v, low, high, rng = Math.random) {
  void v;
  return clamp(Math.round(low + rng() * (high - low)));
}

/**
 * A one-point curve: notes before `pivot` shift by `below`, notes after by `above`.
 * This is how you make the front of a bar hit harder than the tail without
 * touching anything else.
 */
export function curveVelocity(v, position01, pivot, below, above) {
  const shift = position01 <= pivot ? below : above;
  return clamp(v + shift);
}

/**
 * Guard-rail scaling: push everything above `threshold` up by `amount`, so ghost
 * notes stay ghosts and accents get more pronounced.
 */
export function accentVelocity(v, threshold, amount) {
  return v >= threshold ? clamp(v + amount) : v;
}

export function clamp(v) {
  return Math.max(1, Math.min(127, Math.round(v)));
}
