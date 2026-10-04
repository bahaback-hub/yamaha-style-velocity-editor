/**
 * Style structure: which sections a style declares, and which channel carries
 * which voice.
 *
 * This reads the CASM chunk found in exported `.STY` files. CASM holds a series
 * of CSEG groups; each group names the sections it covers and then lists the
 * channels inside it with their voice names ("MainDrum", "NylonGtr", ...).
 *
 * What it cannot give is the note-to-section attribution. In these exports the
 * whole performance is one flattened MIDI timeline with no section boundaries in
 * time, so the section names are the *original style's* declaration, not a
 * description of what plays when. `declaredSectionsPresentInFile` exists to keep
 * that distinction visible instead of letting the caller imply otherwise.
 */

/**
 * @typedef {object} VoiceName
 * @property {number} channel 0-15
 * @property {string} name raw, e.g. "MainDrum" (trailing spaces trimmed)
 * @property {string} family coarse grouping used for timbre and icon
 *
 * @typedef {object} SectionGroup
 * @property {number} index
 * @property {string[]} sections names as declared, e.g. ["Main A", "Intro A"]
 * @property {VoiceName[]} voices
 */

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
 * @param {DataView} view
 * @param {number} casmOffset absolute offset of the CASM chunk header
 * @param {number} casmLength length declared by that header
 * @returns {{groups: SectionGroup[], declaredSections: string[], voices: VoiceName[]}}
 */
export function parseCasm(view, casmOffset, casmLength) {
  const groups = [];
  const declaredSections = [];
  const voices = [];
  const end = casmOffset + 8 + casmLength;

  const idAt = (p) => String.fromCharCode(...new Uint8Array(view.buffer, view.byteOffset + p, 4));

  let p = casmOffset + 8;
  while (p + 8 <= end) {
    if (idAt(p) !== 'CSEG') {
      p++;
      continue;
    }
    const groupLen = view.getUint32(p + 4);
    const groupEnd = Math.min(p + 8 + groupLen, end);

    /** @type {string[]} */
    let sections = [];
    /** @type {VoiceName[]} */
    const groupVoices = [];
    let q = p + 8;

    while (q + 4 <= groupEnd) {
      // A section declaration: "Sdec" + a length, then comma-separated names.
      if (idAt(q) === 'Sdec') {
        const nameLen = view.getUint32(q + 4);
        const body = q + 8;
        if (nameLen > 0 && body + nameLen <= groupEnd) {
          // The declared length runs past the text into whatever padding or the
          // next chunk id follows, so read the bytes and cut at the first
          // character that cannot belong to a section name.
          const raw = new Uint8Array(view.buffer, view.byteOffset + body, nameLen);
          let text = '';
          for (const b of raw) {
            if (b === 0) break; // null padding ends the string
            text += String.fromCharCode(b);
          }
          for (const part of text.split(',')) {
            const name = part.trim();
            if (/^[A-Za-z][A-Za-z0-9 /-]{0,23}$/.test(name)) {
              sections.push(name);
              if (!declaredSections.includes(name)) declaredSections.push(name);
            }
          }
        }
        q = body + nameLen;
        continue;
      }

      // A channel entry: 0x2F, the channel number, then a padded 8-byte name.
      if (view.getUint8(q) === 0x2f) {
        const ch = view.getUint8(q + 1);
        // The channel byte is the same zero-based number the MIDI events use. A
        // style whose parts sit on channels 9-15 one-based declares 9-15 here, and
        // subtracting one shifted every part name onto the wrong channel - which
        // then either failed to match its notes or matched a neighbour's.
        if (ch >= 0 && ch <= 15) {
          let raw = '';
          for (const b of new Uint8Array(view.buffer, view.byteOffset + q + 2, 8)) {
            raw += String.fromCharCode(b);
          }
          const name = raw.replace(/\s+$/g, '').trim();
          if (name) {
            const voice = { channel: ch, name, family: voiceFamily(name) };
            groupVoices.push(voice);
            if (!voices.some((v) => v.channel === voice.channel && v.name === voice.name)) {
              voices.push(voice);
            }
          }
        }
        q += 10;
        continue;
      }

      q++;
    }

    if (sections.length || groupVoices.length) {
      groups.push({ index: groups.length, sections, voices: groupVoices });
    }
    p = groupEnd;
  }

  return { groups, declaredSections, voices };
}

/**
 * Locate the CASM chunk in a bare-MIDI style and parse it.
 *
 * @param {ArrayBuffer} buffer
 * @returns {{groups: SectionGroup[], declaredSections: string[], voices: VoiceName[], found: boolean}}
 */
export function readStyleStructure(buffer) {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const idAt = (p) => String.fromCharCode(...bytes.subarray(p, p + 4));

  // Only a bare SMF carries CASM at the top level; an SFF container keeps its
  // metadata in Smed/Sins and is not handled here.
  if (idAt(0) !== 'MThd') {
    return { groups: [], declaredSections: [], voices: [], found: false };
  }

  let p = 8 + view.getUint32(4);
  while (p + 8 <= bytes.length) {
    const id = idAt(p);
    const len = view.getUint32(p + 4);
    if (id === 'CASM') {
      const parsed = parseCasm(view, p, len);
      return { ...parsed, found: true };
    }
    if (id !== 'MTrk' && id !== 'OTSc' && id !== 'CSEG') break;
    p += 8 + len;
  }
  return { groups: [], declaredSections: [], voices: [], found: false };
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
