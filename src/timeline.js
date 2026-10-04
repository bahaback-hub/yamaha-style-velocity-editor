/**
 * Time layout: bar grid, and detecting where the playing material changes.
 *
 * A Yamaha export carries no section boundaries in time - the whole performance
 * is one flat timeline. So the "blocks" in the UI are not read from the file,
 * they are inferred from where the set of sounding voices changes. That is a
 * heuristic and every view that uses it has to say so; `source` exists so the
 * caller cannot present an inference as a fact.
 */

import { tickToSeconds, ticksPerBar } from './smf.js';

/**
 * Upper bound on grid columns. Every lane renders one element per bar, so a
 * mis-decoded meter would otherwise ask the DOM for hundreds of thousands of
 * nodes and hang the tab. Nothing musical is this long.
 */
export const MAX_BARS = 400;

export const BLOCK_SOURCE = {
  inferred: 'inferred',
  declared: 'declared',
  none: 'none',
};

/**
 * Pick a usable bar grid.
 *
 * These exports write a time-signature meta value that is not always a real
 * meter - the Karadeniz file declares 10/16, which at 1920 ticks per quarter
 * implies six thousand bars of a thirty-four-bar performance. So the declared
 * signature is honoured when it yields a plausible bar count and otherwise
 * replaced by 4/4, with the substitution reported rather than hidden.
 *
 * @param {{numerator: number, denominator: number}} declared
 * @param {number} lengthTicks
 * @param {number} division
 */
export function resolveMeter(declared, lengthTicks, division) {
  const tpb = ticksPerBar(declared, division);
  const bars = tpb > 0 ? lengthTicks / tpb : 0;
  const plausible = tpb > 0 && bars >= 1 && bars <= MAX_BARS;
  if (plausible) {
    return { ...declared, source: BLOCK_SOURCE.declared, bars: Math.ceil(bars), ticksPerBar: tpb };
  }
  const tpbFallback = ticksPerBar({ numerator: 4, denominator: 4 }, division);
  return {
    numerator: 4,
    denominator: 4,
    source: BLOCK_SOURCE.inferred,
    note:
      declared.numerator !== 4 || declared.denominator !== 4
        ? `the file declares ${declared.numerator}/${declared.denominator}, which does not fit this file`
        : '',
    bars: Math.min(MAX_BARS, Math.max(1, Math.ceil(lengthTicks / tpbFallback))),
    ticksPerBar: tpbFallback,
  };
}

/**
 * Convert a tick to a fractional bar under a given grid.
 * @param {number} tick
 * @param {number} ticksPerBarNow
 */
export function tickToBar(tick, ticksPerBarNow) {
  return ticksPerBarNow > 0 ? tick / ticksPerBarNow : 0;
}

/**
 * Detect spans where the set of sounding voices changes.
 *
 * @param {{note: number, channel: number, at: number}[]} notes
 * @param {{bars: number}} meter
 * @param {number} ticksPerBarNow
 * @param {(t: number) => number} [toSeconds]
 * @returns {{index: number, startBar: number, endBar: number, startTick: number, endTick: number, channels: number[], label: string, source: string}[]}
 */
export function detectBlocks(notes, meter, ticksPerBarNow, toSeconds) {
  const totalBars = Math.max(1, meter.bars);
  if (notes.length === 0) return [];

  // Which channels sound in each bar.
  /** @type {Set<number>[]} */
  const perBar = Array.from({ length: totalBars }, () => new Set());
  for (const n of notes) {
    const bar = Math.min(totalBars - 1, Math.floor(tickToBar(n.at, ticksPerBarNow)));
    perBar[bar].add(n.channel);
  }

  const key = (set) => [...set].sort((a, b) => a - b).join(',');
  /** @type {{startBar: number, endBar: number, channels: number[]}[]} */
  const blocks = [];
  let current = null;
  for (let bar = 0; bar < totalBars; bar++) {
    const set = perBar[bar];
    if (set.size === 0) continue; // silence inside a span is not a new block
    const k = key(set);
    if (current && current.key === k) {
      current.endBar = bar + 1;
    } else {
      current = { key: k, startBar: bar, endBar: bar + 1, channels: [...set].sort((a, b) => a - b) };
      blocks.push(current);
    }
  }

  return blocks.map((b, i) => {
    const startTick = b.startBar * ticksPerBarNow;
    const endTick = b.endBar * ticksPerBarNow;
    return {
      index: i,
      startBar: b.startBar,
      endBar: b.endBar,
      startTick,
      endTick,
      channels: b.channels,
      startSeconds: toSeconds ? toSeconds(startTick) : startTick / 1920,
      endSeconds: toSeconds ? toSeconds(endTick) : endTick / 1920,
      label: `Block ${i + 1}`,
      source: BLOCK_SOURCE.inferred,
    };
  });
}

/**
 * Per-voice presence across the bar grid, for the timeline lanes.
 *
 * @param {{note: number, channel: number, at: number}[]} notes
 * @param {{bars: number}} meter
 * @param {number} ticksPerBarNow
 * @returns {Map<number, number[]>} channel -> array of note counts per bar
 */
export function presencePerBar(notes, meter, ticksPerBarNow) {
  const totalBars = Math.max(1, meter.bars);
  /** @type {Map<number, number[]>} */
  const out = new Map();
  for (const n of notes) {
    const bar = Math.min(totalBars - 1, Math.floor(tickToBar(n.at, ticksPerBarNow)));
    let row = out.get(n.channel);
    if (!row) {
      row = new Array(totalBars).fill(0);
      out.set(n.channel, row);
    }
    row[bar]++;
  }
  return out;
}

/** Convenience: a tick-to-seconds converter bound to one tempo map and division. */
export const secondsFor = (tempoMap, division) => (tick) => tickToSeconds(tempoMap, tick, division);
