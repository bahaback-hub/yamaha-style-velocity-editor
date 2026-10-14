/**
 * Variations as they actually occur in the file.
 *
 * The declared map says which parts each variation may use. The markers say when
 * each variation happens. This joins them into one picture, and checks that they
 * agree - which is a real integrity signal rather than a formality, because a
 * disagreement means one of the two readers is wrong.
 *
 * A variation can appear more than once in one style: a form that plays Main A,
 * Main B, then Main A again has one marker each time, and each is a separate span
 * with its own notes. They are kept apart rather than merged, and the repeat is
 * labelled, because merging them would file notes from two different places under
 * one heading.
 */
import { t, cnt } from './i18n.js';

/**
 * @typedef {object} Variation
 * @property {string} name
 * @property {number} index span index, in the order the style plays them
 * @property {number} startTick
 * @property {number} endTick
 * @property {number} bars length in bars
 * @property {number} notes how many notes fall inside it
 * @property {number[]} channels the channels that actually sound
 * @property {number[]} declared the channels the map promises, if it declares this one
 * @property {number} occurrence 1 for the first time a name appears, 2 for the second
 * @property {'exact'|'silent'|'undeclared'|'partial'} match how it lines up with the map
 * @property {string[]} missing declared channels that did not sound
 * @property {number} repeatOf span index of the first span with this name, or -1
 * @property {{numerator: number, denominator: number}} meter the time signature
 *   in effect where the span starts (the last 0x58 event at or before it)
 */

/**
 * Build the variation list for a parsed style.
 *
 * @param {{sectionSpans: any[], notes: any[], lengthTicks: number, division: number, tempoMap: any[]}} parsed
 * @param {{sections: {name: string, channels: number[]}[]}|null} casm
 * @param {{ticksPerBar: number}} meter
 * @returns {Variation[]}
 */
/**
 * The time signature in effect at a tick: the last 0x58 event at or before it,
 * falling back to the file's overall signature when nothing precedes it.
 */
export function meterAt(timeSigEvents, global, tick) {
  let current = global ?? { numerator: 4, denominator: 4 };
  for (const e of timeSigEvents ?? []) {
    if (e.tick <= tick) current = { numerator: e.numerator, denominator: e.denominator };
    else break;
  }
  return current;
}

export function buildVariations(parsed, casm, meter) {
  const declared = new Map((casm?.sections ?? []).map((s) => [s.name, s.channels]));
  /** @type {Map<string, number>} */
  const firstSeen = new Map();
  const tpb = meter.ticksPerBar || 1920;

  return parsed.sectionSpans.map((span, i) => {
    const inside = parsed.notes.filter((n) => n.at >= span.startTick && n.at < span.endTick);
    const channels = [...new Set(inside.map((n) => n.channel))].sort((a, b) => a - b);
    const want = declared.get(span.name);

    // A release from the previous variation overlaps the marker, so extra channels
    // are expected. What must not happen is a promised channel going silent.
    const missing = want && inside.length ? want.filter((c) => !channels.includes(c)) : [];
    let match = 'undeclared';
    if (want) {
      if (inside.length === 0) match = 'silent';
      else if (missing.length === 0) match = 'exact';
      else match = 'partial';
    }

    const occurrence = (firstSeen.get(span.name) ?? 0) + 1;
    if (occurrence === 1) firstSeen.set(span.name, i);

    return {
      name: span.name,
      index: i,
      startTick: span.startTick,
      endTick: span.endTick,
      meter: meterAt(parsed.timeSigEvents, parsed.timeSignature, span.startTick),
      bars: Math.max(1, Math.round((span.endTick - span.startTick) / tpb)),
      notes: inside.length,
      channels,
      declared: want ?? [],
      occurrence,
      repeatOf: occurrence === 1 ? -1 : firstSeen.get(span.name),
      match,
      missing,
    };
  });
}

/**
 * The notes inside one variation.
 *
 * @param {any[]} notes
 * @param {{startTick: number, endTick: number}} span
 */
export function notesInSpan(notes, span) {
  return notes.filter((n) => n.at >= span.startTick && n.at < span.endTick);
}

/**
 * How each variation lines up with the map, said plainly.
 *
 * @param {Variation} v
 * @returns {string}
 */
export function describeMatch(v) {
  if (v.match === 'undeclared') return t('vv_match_undeclared');
  if (v.match === 'silent') return t('vv_match_silent');
  if (v.match === 'partial') {
    return t('vv_match_partial', {
      declared: cnt(v.declared.length, 'part'),
      missing: v.missing.map((c) => `ch${c + 1}`).join(', '),
    });
  }
  return t('vv_match_ok');
}