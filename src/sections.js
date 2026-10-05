/**
 * Style structure: which sections a style declares, and which channel carries
 * which voice.
 *
 * The map itself is read by `cseg.js`, which is the single reader for the CASM
 * format. This module turns what it finds into the shape the interface wants:
 * part names grouped by family, and a list of the variations the style declares.
 *
 * An earlier version of this file had its own CASM parser, and two readers of one
 * format is how they come to disagree - this one went on looking for a 0x2F marker
 * the format does not contain and reported no part names at all.
 *
 * Note on attribution: this used to claim that variations could not be told apart
 * in time, because these exports flatten the performance into one timeline. That is
 * only half true. The performance carries MIDI marker events naming each variation,
 * so the boundaries *are* recorded - see `buildSectionSpans` in `smf.js`. What CASM
 * does not carry is the boundaries, and this module reports that; `smf.js` reports
 * the boundaries. They can be checked against each other, and are.
 */

/**
 * @typedef {object} VoiceName
 * @property {number} channel 0-15
 * @property {string} name raw, e.g. "MainDrum" (trailing spaces trimmed)
 * @property {string} family coarse grouping used for timbre and icon
 *
 * @typedef {object} SectionGroup
 * @property {number} index
 * @property {string[]} sections names as declared, one per group
 * @property {VoiceName[]} voices
 */

import { parseCasm } from './cseg.js';

/** Map a Yamaha voice name onto a coarse family for display and timbre. */
export function voiceFamily(name) {
  const n = (name || '').toLowerCase();
  // "AddDrum" and "MainDrum" carry the word mid-string with no separator, so a
  // boundary-anchored test would miss them and label the drum parts as generic.
  if (/drum|perc|kick|snare|hihat|hi-hat|hat|tom|cymbal|conga|bongo/.test(n)) return 'drums';
  if (/baglama|saz|oud|banjo|mandolin|harp/.test(n)) return 'plucked';
  if (/bass|sub/.test(n)) return 'bass';
  if (/gtr|guitar|nylon|steel|clean|strum|acoustic/.test(n)) return 'guitar';
  if (/pad|string|strings|synth|lead/.test(n)) return 'pad';
  if (/organ|piano|keys|ep/.test(n)) return 'keys';
  if (/brass|horn|trump|sax|flute|reed|wind|tuba/.test(n)) return 'brass';
  if (/voix|vocal|choir|voice/.test(n)) return 'voice';
  return 'other';
}

/** Human label for a declared section name. */
export function sectionLabel(name) {
  const n = (name || '').trim().toLowerCase();
  if (n.startsWith('intro')) return 'Intro';
  if (n.startsWith('fill')) return 'Fill In';
  if (n.startsWith('ending') && !n.includes('normal')) return 'Ending';
  if (n.includes('normal ending') || n === 'ne') return 'Normal Ending';
  if (n.startsWith('main')) return 'Variation';
  if (n.startsWith('bridge')) return 'Bridge';
  return 'Other';
}

/**
 * Parse the CASM chunk of an exported style.
 *
 * This delegates to `cseg.js`, which is the one reader for this format. An earlier
 * version had its own parser here, and two readers of one format is how they come
 * to disagree: the copy in this file went on looking for a 0x2F marker that the
 * format does not have, and silently reported no part names at all. There is one
 * reader now, and it is tested against every style in the collection.
 *
 * @param {ArrayBuffer} buffer
 * @returns {{groups: SectionGroup[], declaredSections: string[], voices: VoiceName[], found: boolean}}
 */
export function readStyleStructure(buffer) {
  /** @type {SectionGroup[]} */
  const groups = [];
  /** @type {string[]} */
  const declaredSections = [];
  /** @type {VoiceName[]} */
  const voices = [];

  let casm = null;
  try {
    casm = parseCasm(buffer);
  } catch {
    // A map in a layout this reader does not understand is reported as absent
    // rather than taking the page down; the notes are still editable.
    return { groups, declaredSections, voices, found: false };
  }
  if (!casm) return { groups, declaredSections, voices, found: false };

  for (const section of casm.sections) {
    /** @type {VoiceName[]} */
    const groupVoices = [];
    for (const part of section.parts) {
      const voice = {
        channel: part.channel,
        name: part.name,
        family: voiceFamily(part.name),
      };
      groupVoices.push(voice);
      if (!voices.some((v) => v.channel === voice.channel && v.name === voice.name)) {
        voices.push(voice);
      }
    }
    if (section.name && !declaredSections.includes(section.name)) {
      declaredSections.push(section.name);
    }
    groups.push({ index: section.index, sections: section.name ? [section.name] : [], voices: groupVoices });
  }

  return { groups, declaredSections, voices, found: true };
}

/**
 * Summarise notes per channel.
 *
 * @param {{note: number, velocity: number, channel: number, at: number}[]} notes
 * @returns {Map<number, {channel: number, count: number, low: number, high: number, velMin: number, velMax: number, velSum: number, firstTick: number, lastTick: number}>}
 */
export function summariseByChannel(notes) {
  /** @type {Map<number, any>} */
  const out = new Map();
  for (const n of notes) {
    let s = out.get(n.channel);
    if (!s) {
      s = {
        channel: n.channel,
        count: 0,
        low: 127,
        high: 0,
        velMin: 128,
        velMax: -1,
        velSum: 0,
        firstTick: n.at,
        lastTick: n.at,
      };
      out.set(n.channel, s);
    }
    s.count++;
    if (n.note < s.low) s.low = n.note;
    if (n.note > s.high) s.high = n.note;
    if (n.velocity < s.velMin) s.velMin = n.velocity;
    if (n.velocity > s.velMax) s.velMax = n.velocity;
    s.velSum += n.velocity;
    if (n.at < s.firstTick) s.firstTick = n.at;
    if (n.at > s.lastTick) s.lastTick = n.at;
  }
  return out;
}
