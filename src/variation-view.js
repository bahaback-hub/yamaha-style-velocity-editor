/**
 * The variation timeline, drawn from the file's markers.
 *
 * This replaces an earlier view that inferred variation boundaries from where the
 * sounding parts changed. That was a guess, and it was wrong in both directions:
 * it invented boundaries where a variation held steady across a change of parts,
 * and it missed a variation that repeated a layout another variation already used.
 * The file records the boundaries itself, so this reads them.
 *
 * Two things are shown on purpose. Where a variation sits in time and how long it
 * lasts, which is what the file says. And whether the parts that sounded during it
 * match what the map declares, which is a check on both halves of the file rather
 * than a claim about either.
 */

import { describeMatch } from './variations.js';

/**
 * @param {HTMLElement} root
 * @param {{
 *   onSelect?: (index: number) => void,
 *   onPlay?: (variation: any) => void,
 * }} [handlers]
 */
export class VariationView {
  constructor(root, handlers = {}) {
    this.root = root;
    this.handlers = handlers;
    /** @type {any[]} */
    this.variations = [];
    this.ticksPerBar = 1920;
    this.selected = -1;
    this.hover = -1;
  }

  /**
   * @param {any[]} variations from buildVariations
   * @param {{ticksPerBar: number}} meter
   */
  render(variations, meter) {
    this.variations = variations;
    this.ticksPerBar = meter.ticksPerBar || 1920;
    this.root.textContent = '';

    if (!variations.length) {
      this.root.innerHTML = '<p class="empty">This file has no variation markers, so the performance has no recorded variation boundaries.</p>';
      return;
    }
    const total = variations[variations.length - 1].endTick || 1;

    for (const v of variations) {
      this.root.append(this.#row(v, total));
    }
  }

  #row(v, total) {
    const row = document.createElement('div');
    row.className = 'var-row';
    row.dataset.index = String(v.index);
    if (v.index === this.selected) row.classList.add('sel');

    const name = document.createElement('button');
    name.type = 'button';
    name.className = 'var-name';
    name.textContent = v.occurrence > 1 ? `${v.name} (${v.occurrence})` : v.name;
    name.title = `${v.bars} bar(s), ${v.notes} note(s)\n${describeMatch(v)}`;
    name.addEventListener('click', () => {
      this.selected = v.index;
      this.#reselect();
      this.handlers.onSelect?.(v.index);
    });
    row.append(name);

    const bar = document.createElement('div');
    bar.className = 'var-bar';

    // The strip is the whole performance, so a variation's position and width are
    // both readable at once.
    const track = document.createElement('div');
    track.className = 'var-track';
    const fill = document.createElement('div');
    fill.className = 'var-fill';
    fill.style.left = `${(v.startTick / total) * 100}%`;
    fill.style.width = `${Math.max(0.4, ((v.endTick - v.startTick) / total) * 100)}%`;
    fill.dataset.match = v.match;
    fill.title = `${v.name}: bars at ${v.startTick / this.ticksPerBar} to ${v.endTick / this.ticksPerBar}`;
    track.append(fill);
    bar.append(track);

    const facts = document.createElement('div');
    facts.className = 'var-facts';
    facts.textContent = `${v.bars} bar${v.bars === 1 ? '' : 's'}`;
    facts.title = `${v.notes} note(s) on ${v.channels.length} part(s)`;
    bar.append(facts);
    row.append(bar);

    const match = document.createElement('span');
    match.className = 'var-match';
    match.dataset.match = v.match;
    match.textContent = v.match === 'exact' ? '✓' : '!';
    match.title = describeMatch(v);
    row.append(match);

    return row;
  }

  #reselect() {
    for (const row of this.root.querySelectorAll('.var-row')) {
      row.classList.toggle('sel', Number(row.dataset.index) === this.selected);
    }
  }
}