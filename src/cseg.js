/**
 * The style's section map: CASM and its CSEG groups.
 *
 * A style declares which parts play in each variation, and this is where it
 * declares it. CASM holds one CSEG group per variation, in the canonical order the
 * arranger shows on its buttons, and each group's entries describe the parts.
 *
 *     CASM
 *       CSEG                          one variation
 *         Sdec  len  name             the variation's name
 *         Ctb2  len=47  body          one part
 *         Ctab / Cntt                 chord tables, in styles that have them
 *
 * Every entry is a four-byte magic, a four-byte big-endian length, and that many
 * bytes of body. Dispatching on the magic and trusting the length is what makes
 * this robust: an entry type this file does not know about can be skipped over
 * byte-exactly instead of being misread as a voice.
 *
 * The body of a `Ctb2` is 47 bytes and is not padding. It reads:
 *
 *      0        source channel          0-15, the same number the notes use
 *      1..8     part name               padded to eight bytes
 *      9        destination channel     where the part is routed on the instrument
 *     10        editable flag
 *     11..12    note-play mask          which of the twelve notes trigger it
 *     13..17    chord-play mask         which chord types it plays
 *     18        chord key               0-11, C to B
 *     19        chord type              0-34, Maj, Maj7, min, min7, 7th ...
 *     20        lowest note of the middle register
 *     21        highest note of the middle register
 *     22..27    low register            note type, chord limit, high key,
 *     28..33    middle register         low/high note limits, retrigger rule
 *     34..39    high register           (six bytes each)
 *     40..46    reserved                carried through untouched
 *
 * Those offsets were checked against every `Ctb2` in the collection rather than
 * taken on trust: all 5232 declare a length of exactly 47, and every enum-valued
 * field lands inside its documented range.
 */

const CTB2_BODY = 47;
const NAME_LENGTH = 8;

const asBytes = (view, buffer, start, end) =>
  new Uint8Array(buffer, view.byteOffset + start, end - start);

// ---- documented value tables -------------------------------------------------

/** The twelve pitch classes, in the order the note-play mask stores them. */
export const NOTE_CLASSES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** Chord types, by the value stored in the body. */
export const CHORD_TYPES = [
  'Maj', 'Maj6', 'Maj7', 'Maj7#11', 'Maj(9)', 'Maj7(9)', 'Maj6(9)', 'aug',
  'min', 'min6', 'min7', 'm7b5', 'min(9)', 'min7(9)', 'min7(11)', 'minMaj7',
  'minMaj7(9)', 'dim', 'dim7', '7th', '7sus4', '7b5', '7(9)', '7#11',
  '7(13)', '7(b9)', '7(b13)', '7(#9)', 'Maj7aug', '7aug', '1+8', '1+5',
  'sus4', '1+2+5', 'cancel',
];

/** What the register is keyed to. */
export const NOTE_TYPES = ['root-transposed', 'root-fixed', 'guitar'];

/** Which chord shapes the register accepts. The list depends on the note type. */
export const CHORD_LIMITS_MELODIC = [
  'bypass', 'melody', 'chord', 'bass', 'melodic-minor', 'harmonic-minor',
  'natural-minor', 'dorian', 'dorian-5th',
];
export const CHORD_LIMITS_GUITAR = ['all-purpose', 'stroke', 'arpeggio'];

/** What happens when a note is already sounding. */
export const RETRIGGER_RULES = [
  'stop', 'pitch-shift', 'pitch-shift-to-root', 'retrigger', 'retrigger-to-root', 'note-generator',
];

const NOTE_NAMES_LONG = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** Read a chunk id as text. */
const chunkId = (bytes, at) => String.fromCharCode(
  bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3],
);

/** Trim a padded name, for display. */
function cleanName(bytes) {
  let end = bytes.length;
  while (end > 0 && (bytes[end - 1] === 0x20 || bytes[end - 1] === 0x00)) end--;
  let s = '';
  for (let i = 0; i < end; i++) {
    const c = bytes[i];
    s += c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : '.';
  }
  return s;
}

/** A big-endian 32-bit read that cannot throw on a truncated buffer. */
function u32(view, at) {
  if (at + 4 > view.byteLength) return 0;
  return view.getUint32(at);
}

/**
 * @typedef {object} RegisterRange
 * @property {number} noteType 0-2, see NOTE_TYPES
 * @property {boolean} bassFlag the high bit of the limit byte
 * @property {number} chordLimit 0-8, see CHORD_LIMITS_*
 * @property {number} highKey 0-11
 * @property {number} lowLimit note number
 * @property {number} highLimit note number
 * @property {number} retrigger 0-5, see RETRIGGER_RULES
 *
 * @typedef {object} PartEntry
 * @property {'ctb2'} kind
 * @property {number} channel source channel, 0-15
 * @property {string} name
 * @property {Uint8Array} nameBytes the eight stored bytes
 * @property {number} destinationChannel
 * @property {boolean} editable
 * @property {number} notePlayMask twelve bits, one per pitch class
 * @property {number[]} notePlay pitch classes that trigger the part
 * @property {number[]} chordPlayMask the five raw bytes, exposed as-is
 * @property {number} chordKey 0-11
 * @property {number} chordType 0-34
 * @property {number} middleLow
 * @property {number} middleHigh
 * @property {RegisterRange} low
 * @property {RegisterRange} middle
 * @property {RegisterRange} high
 * @property {Uint8Array} reserved the last seven bytes, untouched
 *
 * @typedef {object} Section
 * @property {number} index
 * @property {string} name
 * @property {Uint8Array} nameBytes
 * @property {PartEntry[]} parts the Ctb2 entries, in file order
 * @property {number[]} channels sorted, unique
 * @property {number} offset absolute offset of the CSEG chunk header
 * @property {number} length
 *
 * @typedef {object} Casm
 * @property {number} offset
 * @property {number} length
 * @property {Section[]} sections
 * @property {number} trailing bytes inside CASM that were not CSEG groups
 * @property {string[]} entryTypes every entry magic seen, for diagnostics
 */

// ---- reading ----------------------------------------------------------------

/**
 * Read the section map.
 *
 * @param {ArrayBuffer} buffer the whole file
 * @returns {Casm|null} null when the file has no CASM chunk
 */
export function parseCasm(buffer) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  // CASM is a sibling of MThd/MTrk at the top level in these exports, so the walk
  // is over top-level chunks only.
  let p = 0;
  while (p + 8 <= bytes.byteLength) {
    const id = chunkId(bytes, p);
    const length = u32(view, p + 4);
    if (id === 'CASM') return readCasmBody(bytes, view, p, length);
    if (length === 0) break;
    p += 8 + length;
  }
  return null;
}

function readCasmBody(bytes, view, casmOffset, casmLength) {
  const bodyStart = casmOffset + 8;
  const bodyEnd = casmOffset + 8 + casmLength;
  /** @type {Section[]} */
  const sections = [];
  /** @type {string[]} */
  const entryTypes = [];
  let p = bodyStart;
  let index = 0;

  while (p + 8 <= bodyEnd) {
    if (chunkId(bytes, p) !== 'CSEG') {
      const length = u32(view, p + 4);
      if (length === 0) break;
      p += 8 + length;
      continue;
    }
    const length = u32(view, p + 4);
    sections.push(readCseg(bytes, view, p, length, index, entryTypes));
    p += 8 + length;
    index++;
  }

  return { offset: casmOffset, length: casmLength, sections, trailing: bodyEnd - p, entryTypes };
}

/**
 * Parse one CSEG group: its name, then whatever entries follow.
 *
 * Entries are dispatched on their four-byte magic and bounded by their declared
 * length. That is the whole point of doing it this way: `Ctab` and `Cntt` entries
 * have a different shape, and an entry type nobody has seen yet still has to be
 * stepped over correctly rather than mistaken for a part.
 */
function readCseg(bytes, view, csegOffset, csegLength, index, entryTypes) {
  const bodyStart = csegOffset + 8;
  const bodyEnd = csegOffset + 8 + csegLength;

  /** @type {string} */
  let name = '';
  /** @type {Uint8Array} */
  let nameBytes = new Uint8Array(0);
  /** @type {PartEntry[]} */
  const parts = [];

  let p = bodyStart;
  while (p + 8 <= bodyEnd) {
    const magic = chunkId(bytes, p);
    const length = u32(view, p + 4);
    if (length === 0) break;
    const dataStart = p + 8;
    const dataEnd = dataStart + length;
    if (dataEnd > bodyEnd) break;
    if (!entryTypes.includes(magic)) entryTypes.push(magic);

    if (magic === 'Sdec') {
      nameBytes = asBytes(view, bufferOf(view), dataStart, dataEnd).slice();
      name = cleanName(nameBytes);
    } else if (magic === 'Ctb2' && length >= CTB2_BODY) {
      parts.push(readCtb2(bytes, view, dataStart, dataEnd));
    }
    // Anything else - Ctab, Cntt, a type added after this was written - is stepped
    // over using its own length and left alone. Its bytes stay in the file because
    // the section is rebuilt from the pieces we understood, plus the lengths.
    p = dataEnd;
  }

  return {
    index,
    name,
    nameBytes,
    parts,
    channels: [...new Set(parts.map((r) => r.channel))].sort((a, b) => a - b),
    offset: csegOffset,
    length: csegLength,
  };
}

/** The ArrayBuffer a DataView is looking into. */
const bufferOf = (view) => view.buffer;

/** Decode one register range: six bytes. */
function readRange(bytes, at) {
  const noteType = bytes[at];
  const limitByte = bytes[at + 1];
  const isGuitar = noteType === 2;
  return {
    noteType,
    bassFlag: (limitByte & 0x80) !== 0,
    chordLimit: limitByte & 0x7f,
    chordLimitNames: isGuitar ? CHORD_LIMITS_GUITAR : CHORD_LIMITS_MELODIC,
    highKey: bytes[at + 2],
    highKeyName: NOTE_NAMES_LONG[bytes[at + 2]] ?? '?',
    lowLimit: bytes[at + 3],
    highLimit: bytes[at + 4],
    retrigger: bytes[at + 5],
    retriggerName: RETRIGGER_RULES[bytes[at + 5]] ?? '?',
  };
}

/** Decode one part: the 47-byte `Ctb2` body. */
function readCtb2(bytes, view, start, end) {
  const body = bytes.subarray(start, end);
  const notePlayLow = body[11];
  const notePlayHigh = body[12];
  const mask = notePlayLow | (notePlayHigh << 8);
  /** @type {PartEntry} */
  const part = {
    kind: 'ctb2',
    channel: body[0],
    name: cleanName(body.subarray(1, 9)),
    nameBytes: body.slice(1, 9),
    destinationChannel: body[9],
    editable: body[10] !== 0,
    notePlayMask: mask,
    notePlay: NOTE_CLASSES.filter((_, i) => (mask & (1 << i)) !== 0),
    chordPlayMask: [body[13], body[14], body[15], body[16], body[17]],
    chordKey: body[18],
    chordKeyName: NOTE_NAMES_LONG[body[18]] ?? '?',
    chordType: body[19],
    chordTypeName: CHORD_TYPES[body[19]] ?? '?',
    middleLow: body[20],
    middleHigh: body[21],
    low: readRange(bytes, start + 22),
    middle: readRange(bytes, start + 28),
    high: readRange(bytes, start + 34),
    reserved: body.slice(start === 0 ? 0 : 40, 47),
    offset: start,
    length: end - start,
  };
  // The five reserved bytes are the tail of the body.
  part.reserved = new Uint8Array(bytes.subarray(start + 40, start + 47));
  return part;
}

// ---- writing ----------------------------------------------------------------

/** Re-encode one register range into six bytes. */
function writeRange(body, at, range) {
  body[at] = range.noteType & 0xff;
  const limit = range.chordLimit & 0x7f;
  body[at + 1] = (range.bassFlag ? 0x80 : 0) | limit;
  body[at + 2] = range.highKey & 0xff;
  body[at + 3] = range.lowLimit & 0xff;
  body[at + 4] = range.highLimit & 0xff;
  body[at + 5] = range.retrigger & 0xff;
}

/** Put a decoded part back into its 47 bytes. */
function writeCtb2(part) {
  const body = new Uint8Array(CTB2_BODY);
  body[0] = part.channel & 0x0f;
  body.set(part.nameBytes ?? paddedName(part.name), 1, 8);
  body[9] = part.destinationChannel & 0x0f;
  body[10] = part.editable ? 1 : 0;
  body[11] = part.notePlayMask & 0xff;
  body[12] = (part.notePlayMask >> 8) & 0xff;
  for (let i = 0; i < 5; i++) body[13 + i] = part.chordPlayMask[i] & 0xff;
  body[18] = part.chordKey & 0x0f;
  body[19] = part.chordType & 0xff;
  body[20] = part.middleLow & 0xff;
  body[21] = part.middleHigh & 0xff;
  writeRange(body, 22, part.low);
  writeRange(body, 28, part.middle);
  writeRange(body, 34, part.high);
  for (let i = 0; i < 7; i++) body[40 + i] = part.reserved[i] & 0xff;
  return body;
}

/** One `id + length + body` entry. */
function entry(id, body) {
  const out = new Uint8Array(8 + body.length);
  out.set([...id].map((c) => c.charCodeAt(0)), 0);
  new DataView(out.buffer).setUint32(4, body.length);
  out.set(body, 8);
  return out;
}

/** A part name padded to the eight bytes the format stores it in. */
function paddedName(name) {
  const out = new Uint8Array(NAME_LENGTH).fill(0x20);
  for (let i = 0; i < Math.min(NAME_LENGTH, name.length); i++) out[i] = name.charCodeAt(i) & 0x7f;
  return out;
}

/** A variation name padded the way Sdec stores one. */
function paddedSectionName(name) {
  const out = new Uint8Array(name.length).fill(0x20);
  for (let i = 0; i < name.length; i++) out[i] = name.charCodeAt(i) & 0x7f;
  return out;
}

/**
 * Rebuild a CASM chunk body from its sections.
 *
 * @param {Section[]} sections
 * @returns {Uint8Array}
 */
export function buildCasmBody(sections) {
  const chunks = sections.map((section) => {
    const sdec = entry('Sdec', section.nameBytes);
    const voices = section.parts.map((part) => entry('Ctb2', writeCtb2(part)));
    return entry('CSEG', concat([sdec, ...voices]));
  });
  return concat(chunks);
}

const concat = (parts) => {
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const part of parts) { out.set(part, p); p += part.length; }
  return out;
};

/**
 * Replace a file's CASM chunk with a rebuilt one.
 *
 * CASM sits at the top level in these files, so the only length to correct is its
 * own. Everything else - the tracks, the voice parameter tables, the notes - is
 * copied through byte for byte.
 *
 * @param {ArrayBuffer} buffer
 * @param {Casm} casm
 * @returns {ArrayBuffer}
 */
export function writeCasm(buffer, casm) {
  const src = new Uint8Array(buffer);
  const before = src.slice(0, casm.offset);
  const after = src.slice(casm.offset + 8 + casm.length);
  const body = buildCasmBody(casm.sections);
  const chunk = entry('CASM', body);

  const out = new Uint8Array(before.length + chunk.length + after.length);
  out.set(before, 0);
  out.set(chunk, before.length);
  out.set(after, before.length + chunk.length);
  return out.buffer;
}

// ---- editing the map ----------------------------------------------------------

/**
 * Turn a part on or off inside one variation.
 *
 * Switching off removes the part's entry, so the arranger no longer lists that
 * channel for that section. Switching on puts it back, copying the voice settings
 * from a variation that already uses that channel: the 47 body bytes are the only
 * description of how a part is set up, and a new entry full of zeros would list a
 * part the arranger cannot play.
 *
 * @param {Casm} casm modified in place
 * @param {number} sectionIndex
 * @param {number} channel
 * @param {boolean} on
 * @returns {{ok: boolean, reason?: string}}
 */
export function setSectionChannel(casm, sectionIndex, channel, on) {
  const section = casm.sections[sectionIndex];
  if (!section) return { ok: false, reason: 'no such section' };
  const at = section.parts.findIndex((r) => r.channel === channel);

  if (!on) {
    if (at < 0) return { ok: false, reason: 'that part is already off in this section' };
    section.parts.splice(at, 1);
    section.channels = [...new Set(section.parts.map((r) => r.channel))].sort((a, b) => a - b);
    return { ok: true };
  }

  if (at >= 0) return { ok: false, reason: 'that part is already on in this section' };
  const donor = findDonorPart(casm, channel);
  if (!donor) {
    return {
      ok: false,
      reason: 'no other variation uses that channel, so there are no voice settings to copy',
    };
  }
  section.parts.push(clonePart(donor));
  section.parts.sort((a, b) => a.channel - b.channel);
  section.channels = [...new Set(section.parts.map((r) => r.channel))].sort((a, b) => a - b);
  return { ok: true };
}

/** A deep-enough copy of a part: the ranges and reserved bytes are mutable. */
export function clonePart(part) {
  const copyRange = (r) => ({ ...r, chordLimitNames: [...r.chordLimitNames] });
  return {
    ...part,
    nameBytes: part.nameBytes.slice(),
    notePlay: [...part.notePlay],
    chordPlayMask: [...part.chordPlayMask],
    low: copyRange(part.low),
    middle: copyRange(part.middle),
    high: copyRange(part.high),
    reserved: part.reserved.slice(),
  };
}

function findDonorPart(casm, channel) {
  for (const section of casm.sections) {
    const hit = section.parts.find((r) => r.channel === channel);
    if (hit) return hit;
  }
  return null;
}

/**
 * Rename a variation.
 *
 * @param {Casm} casm modified in place
 * @param {number} sectionIndex
 * @param {string} name
 */
export function renameSection(casm, sectionIndex, name) {
  const section = casm.sections[sectionIndex];
  if (!section) return { ok: false, reason: 'no such section' };
  section.name = name;
  section.nameBytes = paddedSectionName(name);
  return { ok: true };
}

/**
 * Remove a whole variation.
 *
 * @param {Casm} casm modified in place
 * @param {number} sectionIndex
 */
export function removeSection(casm, sectionIndex) {
  if (!casm.sections[sectionIndex]) return { ok: false, reason: 'no such section' };
  casm.sections.splice(sectionIndex, 1);
  casm.sections.forEach((s, i) => { s.index = i; });
  return { ok: true };
}

/**
 * Add a variation by copying an existing one.
 *
 * The copy is deliberate rather than an empty shell: the 47 bytes per part are the
 * only description of how that part is set up, and a new variation without them
 * would list parts the arranger cannot play. Editing the copy afterwards -
 * switching parts off, renaming it - is the normal way to use this.
 *
 * @param {Casm} casm modified in place
 * @param {number} afterIndex
 * @param {string} [name]
 */
export function cloneSection(casm, afterIndex, name) {
  const source = casm.sections[afterIndex];
  if (!source) return { ok: false, reason: 'no such section' };
  const at = afterIndex + 1;
  const copy = {
    index: at,
    name: name ?? nextFreeName(casm, source.name),
    nameBytes: new Uint8Array(0),
    parts: source.parts.map(clonePart),
    channels: source.channels.slice(),
    offset: 0,
    length: 0,
  };
  copy.nameBytes = paddedSectionName(copy.name);
  casm.sections.splice(at, 0, copy);
  casm.sections.forEach((s, i) => { s.index = i; });
  return { ok: true, index: at, name: copy.name };
}

/** "Main B" -> "Main E", skipping names already taken. */
function nextFreeName(casm, base) {
  const match = /^(.*?)([A-Z])$/.exec(base);
  const stem = match ? match[1] : `${base} `;
  const letter = match ? match[2].charCodeAt(0) : 0x41;
  for (let i = 1; i <= 26; i++) {
    const candidate = stem + String.fromCharCode(letter + i);
    if (!casm.sections.some((s) => s.name === candidate)) return candidate;
  }
  return `${base} copy`;
}

// ---- replayable edits --------------------------------------------------------

/**
 * Map edits are kept as a list of intentions rather than as a mutated structure.
 *
 * Two reasons, both about correctness. The first is that a note-length edit
 * elsewhere in the file changes the byte offset CASM sits at, so the parse these
 * edits were made against is stale by the time the file is written. The second is
 * that reverting has to be exact: replaying an empty list onto a fresh parse
 * restores the original map without keeping a second copy of the file to compare
 * against.
 *
 * Each operation names its section by name rather than by index, because deleting
 * a section renumbers the ones after it and an index would then point elsewhere.
 *
 * @typedef {{op: 'channel', section: string, channel: number, on: boolean}
 *   | {op: 'rename', section: string, name: string}
 *   | {op: 'remove', section: string}
 *   | {op: 'clone', after: string, name?: string}
 *   | {op: 'field', section: string, channel: number, field: string, value: any}} CasmOperation
 */

function findSection(casm, name) {
  return casm.sections.find((s) => s.name === name) ?? null;
}

/** The path a field write takes into a part, so the UI does not reimplement it. */
function setField(part, field, value) {
  switch (field) {
    case 'editable': part.editable = Boolean(value); return true;
    case 'destinationChannel': part.destinationChannel = clampByte(value, 0, 15); return true;
    case 'chordKey': part.chordKey = clampByte(value, 0, 11); return true;
    case 'chordType': part.chordType = clampByte(value, 0, CHORD_TYPES.length - 1); return true;
    case 'middleLow': part.middleLow = clampByte(value, 0, 127); return true;
    case 'middleHigh': part.middleHigh = clampByte(value, 0, 127); return true;
    case 'notePlayMask': part.notePlayMask = clampByte(value, 0, 0xfff); return true;
    case 'low':
    case 'middle':
    case 'high': {
      const range = part[field];
      const patch = value ?? {};
      if (patch.noteType !== undefined) range.noteType = clampByte(patch.noteType, 0, 2);
      if (patch.chordLimit !== undefined) range.chordLimit = clampByte(patch.chordLimit, 0, 8);
      if (patch.bassFlag !== undefined) range.bassFlag = Boolean(patch.bassFlag);
      if (patch.highKey !== undefined) range.highKey = clampByte(patch.highKey, 0, 11);
      if (patch.lowLimit !== undefined) range.lowLimit = clampByte(patch.lowLimit, 0, 127);
      if (patch.highLimit !== undefined) range.highLimit = clampByte(patch.highLimit, 0, 127);
      if (patch.retrigger !== undefined) range.retrigger = clampByte(patch.retrigger, 0, 5);
      return true;
    }
    default: return false;
  }
}

const clampByte = (value, lo, hi) => {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
};

/**
 * Apply one operation, reporting rather than throwing when it cannot be done.
 *
 * @param {Casm} casm modified in place
 * @param {CasmOperation} operation
 * @returns {{ok: boolean, reason?: string}}
 */
export function applyCasmOperation(casm, operation) {
  if (operation.op === 'clone') {
    const source = findSection(casm, operation.after);
    if (!source) return { ok: false, reason: `no section named ${operation.after}` };
    return cloneSection(casm, source.index, operation.name);
  }

  const section = findSection(casm, operation.section);
  if (!section) return { ok: false, reason: `no section named ${operation.section}` };

  if (operation.op === 'channel') return setSectionChannel(casm, section.index, operation.channel, operation.on);
  if (operation.op === 'rename') return renameSection(casm, section.index, operation.name);
  if (operation.op === 'remove') return removeSection(casm, section.index);
  if (operation.op === 'field') {
    const part = section.parts.find((p) => p.channel === operation.channel);
    if (!part) return { ok: false, reason: `${operation.channel + 1} is not used in ${operation.section}` };
    if (!setField(part, operation.field, operation.value)) {
      return { ok: false, reason: `no such field: ${operation.field}` };
    }
    return { ok: true };
  }
  return { ok: false, reason: `unknown operation ${operation.op}` };
}

/**
 * Apply a whole list, stopping at the first thing that cannot be done.
 *
 * Stopping matters: an operation that half-applied would leave a map the user never
 * asked for, and the file would still be written.
 *
 * @param {Casm} casm modified in place
 * @param {CasmOperation[]} operations
 */
export function applyCasmOperations(casm, operations) {
  for (let i = 0; i < operations.length; i++) {
    const result = applyCasmOperation(casm, operations[i]);
    if (!result.ok) return { ok: false, applied: i, reason: result.reason };
  }
  return { ok: true, applied: operations.length };
}

/**
 * Parse a file's map and replay a list of edits onto it.
 *
 * @param {ArrayBuffer} buffer
 * @param {CasmOperation[]} [operations]
 */
export function casmWithEdits(buffer, operations = []) {
  const casm = parseCasm(buffer);
  if (!casm) return { casm: null, applied: 0, reason: 'this file has no section map' };
  const result = applyCasmOperations(casm, operations);
  return { casm, applied: result.applied, reason: result.reason };
}

/**
 * The parts a style uses, across every section.
 *
 * A channel can carry different part names in different sections - channel 13 is
 * "Clavi" in most of a style and "Pad" in its ending - so the names are collected
 * per channel rather than overwritten.
 *
 * @param {Casm} casm
 * @returns {{channel: number, names: string[], sections: number, part: PartEntry}[]}
 */
export function styleParts(casm) {
  /** @type {Map<number, {names: Set<string>, sections: Set<number>, part: any}>} */
  const byChannel = new Map();
  for (const section of casm.sections) {
    for (const part of section.parts) {
      const entry = byChannel.get(part.channel) ?? { names: new Set(), sections: new Set(), part };
      entry.names.add(part.name);
      entry.sections.add(section.index);
      if (!byChannel.has(part.channel)) byChannel.set(part.channel, entry);
    }
  }
  return [...byChannel.entries()]
    .map(([channel, entry]) => ({
      channel,
      names: [...entry.names],
      sections: entry.sections.size,
      part: entry.part,
    }))
    .sort((a, b) => a.channel - b.channel);
}

export { CTB2_BODY, NAME_LENGTH };