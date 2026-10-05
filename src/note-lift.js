/**
 * Lift one note's velocity everywhere, in one control.
 *
 * This is the gesture that comes up most: the kick is too soft in the quiet bars,
 * or the riq throat sits at 90 in one variation and 110 in another, and the fix is
 * to move one note rather than to re-tune a whole part. Making that a selection
 * plus a slider is a lot of ceremony for a small, repeated job.
 *
 * So it is its own control: pick the part, pick the note, and the velocity applies
 * to every occurrence - in the whole style, or in the one variation selected in the
 * form above. Both are scopes the file can answer exactly, because the marker
 * events record where each variation begins and ends.
 *
 * Every operation is relative to the note's own current value rather than absolute,
 * so lifting the same control twice does what a musician means by "a bit louder"
 * instead of pinning everything to one number.
 */

import {
  offsetVelocity, humanizeVelocity, randomVelocity,
  curveVelocity, accentVelocity, clamp,
} from './velocity-lane.js';

/**
 * @typedef {'up'|'down'|'set'|'accent'|'humanise'|'random'|'curve'} LiftKind
 */

/**
 * @param {HTMLElement} root
 * @param {{
 *   notes?: () => any[],
 *   partNames?: () => {channel: number, label: string}[],
 *   variations?: () => any[],
 *   variationIndex?: () => number,
 *   ticksPerBar?: () => number,
 *   current?: (note: any) => number,
 *   apply?: (targets: {note: any, velocity: number}[]) => void,
 *   scope?: () => 'all'|'variation',
 *   setScope?: (scope: 'all'|'variation') => void,
 * }} handlers
 */
export class NoteLift {
  constructor(root, handlers = {}) {
    this.root = root;
    this.handlers = handlers;
    this.channel = null;
    this.pitch = null;
    // The step for Louder and Softer, and the target for Set to. It is small on
    // purpose: this control is for nudging one note, and a step of 100 turned every
    // occurrence into a 127 on the first press, which is not what "a bit louder"
    // means to anyone playing the part.
    this.value = 10;
    this.spread = 12;
  }

  /** @param {{parts: any[], variations: any[], notes: any[]}} data */
  render(data) {
    this.data = data;
    this.root.textContent = '';
    if (!data.parts.length) {
      this.root.innerHTML = '<p class="empty">No parts found.</p>';
      return;
    }
    this.root.append(this.#row());
    // The note row is rebuilt whenever the part changes, so it lives in its own
    // host that can be emptied. Appending a fresh row to the root each time left
    // the previous one in place, and two rows both claiming the same element id.
    this.noteHost = document.createElement('div');
    this.noteHost.className = 'lift-note-host';
    this.root.append(this.noteHost);
    this.#renderNoteRow();
  }

  #row() {
    const row = document.createElement('div');
    row.className = 'lift-row';

    const part = document.createElement('select');
    part.className = 'lift-select';
    part.id = 'liftPart';
    for (const p of this.data.parts) {
      const o = document.createElement('option');
      o.value = String(p.channel);
      o.textContent = `${p.label} · ch ${p.channel + 1}`;
      part.append(o);
    }
    if (this.channel === null) this.channel = this.data.parts[0].channel;
    part.value = String(this.channel);
    part.addEventListener('change', () => {
      this.channel = Number(part.value);
      this.pitch = null;
      this.#renderNoteRow();
    });

    const scope = document.createElement('select');
    scope.className = 'lift-select';
    scope.id = 'liftScope';
    for (const [value, label] of [
      ['all', 'Whole style'],
      ['variation', 'This variation only'],
    ]) {
      const o = document.createElement('option');
      o.value = value;
      o.textContent = label;
      scope.append(o);
    }
    scope.value = this.handlers.scope?.() ?? 'all';
    scope.addEventListener('change', () => this.handlers.setScope?.(scope.value));

    row.append(this.#field('Part', part), this.#field('Applies to', scope));
    return row;
  }

  #renderNoteRow() {
    if (!this.noteHost) return;
    this.noteHost.textContent = '';
    const row = document.createElement('div');
    row.className = 'lift-row';

    const notes = [...new Set(this.data.notes
      .filter((n) => n.channel === this.channel)
      .map((n) => n.note))]
      .sort((a, b) => a - b);

    if (!notes.length) {
      row.innerHTML = '<p class="empty">This part has no notes.</p>';
      this.noteHost.append(row);
      this.summaryEl = null;
      return;
    }
    if (this.pitch === null || !notes.includes(this.pitch)) this.pitch = notes[0];

    const note = document.createElement('select');
    note.className = 'lift-select';
    note.id = 'liftNote';
    for (const p of notes) {
      const o = document.createElement('option');
      o.value = String(p);
      o.textContent = `${noteName(p)} (${p})`;
      note.append(o);
    }
    note.value = String(this.pitch);
    note.addEventListener('change', () => {
      this.pitch = Number(note.value);
      this.#renderSummary();
    });

    const value = document.createElement('input');
    value.type = 'text';
    value.inputMode = 'numeric';
    value.id = 'liftValue';
    value.className = 'lift-number';
    value.value = String(this.value);
    value.title = 'How much Louder and Softer move each occurrence, and what Set to puts it at';
    value.addEventListener('change', () => { this.value = clamp(Number(value.value) || this.value); value.value = String(this.value); this.#renderSummary(); });

    const spread = document.createElement('input');
    spread.type = 'text';
    spread.inputMode = 'numeric';
    spread.id = 'liftSpread';
    spread.className = 'lift-number';
    spread.value = String(this.spread);
    spread.title = 'Humanise spread';
    spread.addEventListener('change', () => { this.spread = Math.max(0, Math.min(126, Number(spread.value) || 0)); spread.value = String(this.spread); });

    const buttons = document.createElement('div');
    buttons.className = 'lift-buttons';
    for (const [kind, label, title] of [
      ['up', 'Louder', 'Add the value to every occurrence'],
      ['down', 'Softer', 'Take the value off every occurrence'],
      ['set', 'Set to', 'Put every occurrence at the value'],
      ['accent', 'Accent', 'Add the value only where the note is already loud'],
      ['humanise', 'Humanise', 'Spread the occurrences around by the spread value'],
      ['random', 'Random', 'Scatter the occurrences across the whole range'],
      ['curve', 'Curve', 'Louder towards the end of the variation, quieter at the start'],
    ]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn btn-sm';
      b.dataset.lift = kind;
      b.textContent = label;
      b.title = title;
      b.addEventListener('click', () => this.#run(kind));
      buttons.append(b);
    }

    row.append(
      this.#field('Note', note),
      this.#field('Value', value),
      this.#field('Spread', spread),
    );
    row.append(buttons);

    const summary = document.createElement('p');
    summary.className = 'lift-summary';
    summary.id = 'liftSummary';
    row.append(summary);

    this.noteHost.append(row);
    this.summaryEl = summary;
    this.#renderSummary();
  }

  #field(label, control) {
    const wrap = document.createElement('label');
    wrap.className = 'lift-field';
    const span = document.createElement('span');
    span.textContent = label;
    wrap.append(span, control);
    return wrap;
  }

  /** The occurrences the current scope covers, and what they look like now. */
  #targets() {
    const all = this.handlers.notes?.() ?? this.data.notes;
    const chosen = all.filter((n) => n.channel === this.channel && n.note === this.pitch);
    const scope = this.handlers.scope?.() ?? 'all';
    if (scope === 'variation') {
      const index = this.handlers.variationIndex?.();
      const span = (this.handlers.variations?.() ?? this.data.variations)[index];
      if (!span) return chosen;
      return chosen.filter((n) => n.at >= span.startTick && n.at < span.endTick);
    }
    return chosen;
  }

  #renderSummary() {
    if (!this.summaryEl) return;
    const targets = this.#targets();
    if (!targets.length) {
      this.summaryEl.textContent = 'Nothing to change in this scope.';
      return;
    }
    const values = targets.map((n) => this.handlers.current ? this.handlers.current(n) : n.velocity);
    const bars = new Set(targets.map((n) => Math.floor(n.at / (this.handlers.ticksPerBar?.() ?? 1920)))).size;
    this.summaryEl.textContent =
      `${targets.length} occurrence${targets.length === 1 ? '' : 's'} across ${bars} bar${bars === 1 ? '' : 's'}`
      + ` · velocity now ${Math.min(...values)}\u2013${Math.max(...values)}, avg ${(values.reduce((a, b) => a + b, 0) / values.length).toFixed(1)}`;
  }

  #run(kind) {
    const targets = this.#targets();
    if (!targets.length) return;
    const span = (this.handlers.variations?.() ?? this.data.variations)[this.handlers.variationIndex?.() ?? 0];
    const from = span?.startTick ?? 0;
    const to = span?.endTick ?? 1;
    let seed = 0x9e3779b9;
    const rng = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };

    const changes = targets.map((note) => {
      const current = this.handlers.current ? this.handlers.current(note) : note.velocity;
      let next = current;
      if (kind === 'up') next = offsetVelocity(current, this.value);
      else if (kind === 'down') next = offsetVelocity(current, -this.value);
      else if (kind === 'set') next = this.value;
      else if (kind === 'accent') next = accentVelocity(current, 100, this.value);
      else if (kind === 'humanise') next = humanizeVelocity(current, this.spread, rng);
      else if (kind === 'random') next = randomVelocity(current, 1, 127, rng);
      else if (kind === 'curve') {
        next = curveVelocity(current, (note.at - from) / Math.max(1, to - from), 0.5, -this.value, this.value);
      }
      return next === current ? null : { note, velocity: next };
    });

    const applied = changes.filter(Boolean);
    if (!applied.length) {
      // Nothing moved, and saying so beats a button that appears to work.
      this.summaryEl.textContent = 'Nothing to change: every occurrence is already there.';
      return;
    }
    this.handlers.apply?.(applied);
  }
}

/** A readable note name, so the selector does not say "36" on its own. */
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
function noteName(midi) {
  return `${NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`;
}