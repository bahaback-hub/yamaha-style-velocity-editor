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
import { t, cnt } from './i18n.js';

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
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = t('vv_no_bounds');
      this.root.append(empty);
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
    name.title = t('vv_bar_title', { bars: cnt(v.bars, 'bar'), notes: cnt(v.notes, 'note'), match: describeMatch(v) });
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
    fill.title = t('vv_range_title', { name: v.name, a: v.startTick / this.ticksPerBar, b: v.endTick / this.ticksPerBar });
    track.append(fill);
    bar.append(track);

    const meter = v.meter ?? { numerator: 4, denominator: 4 };
    const meterLabel = `${meter.numerator}/${meter.denominator}`;
    const facts = document.createElement('div');
    facts.className = 'var-facts';
    facts.textContent = t('vv_facts_line', { bars: cnt(v.bars, 'bar'), meter: meterLabel });
    facts.title = t('vv_facts', { notes: cnt(v.notes, 'note'), parts: cnt(v.channels.length, 'part') });
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