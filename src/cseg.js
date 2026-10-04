/**
 * The style's section map: CASM and its CSEG groups.
 *
 * A style declares which parts play in each variation, and this is where it
 * declares it. CASM holds one CSEG group per variation, in the canonical order
 * the arranger shows on its buttons - Main A through Main D, the fills, the
 * intros, the endings - and each group says which channels sound and under what
 * part name.
 *
 *     CASM
 *       CSEG  <- Intro A
 *         Sdec                      the variation's name
 *         Ctb2 00 00 00              per-record tag
 *         2F 09 "Rhythm2    "        channel 9, part name
 *         <38 parameter bytes>
 *         Ctb2 00 00 00
 *         2F 0A "Bass      "
 *         <38 parameter bytes>
 *       CSEG  <- Main A
 *         ...
 *
 * Every voice record is exactly 55 bytes, which is what makes this tractable:
 * 7 of tag, 1 for the 0x2F marker, 1 for the channel, 8 for the padded name and
 * 38 of parameters. The arithmetic checks out on real files - a Main A with six
 * parts is 14 + 6 * 55 = 344 bytes, a Main B with five is 14 + 5 * 55 = 289 -
 * and `parse -> write` is asserted to be byte-identical across a whole
 * collection before any edit is allowed near it.
 *
 * The 38 parameter bytes are not decoded here. They belong to the voice, not to
 * the map, and the first of them is the channel number again. They are carried
 * verbatim in both directions, so an edit to the map cannot disturb them.
 */

const TAG_LENGTH = 7;
const NAME_LENGTH = 8;
const PARAMS_LENGTH = 38;
const RECORD_LENGTH = TAG_LENGTH + 1 + 1 + NAME_LENGTH + PARAMS_LENGTH;

/** Read a chunk id as text. */
const chunkId = (bytes, at) => String.fromCharCode(
  bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3],
);

/** The 4-byte big-endian length that follows every chunk id. */
function chunkLength(view, at) {
  return view.getUint32(at + 4);
}

/** Trim a padded name and drop anything unprintable, for display. */
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

/**
 * @typedef {object} SectionRecord
 * @property {number} index position within the section
 * @property {number} channel 0-15, as the notes use it
 * @property {string} name the part name, trimmed
 * @property {Uint8Array} tag the record's leading bytes, kept verbatim
 * @property {Uint8Array} params the voice parameters, kept verbatim
 *
 * @typedef {object} Section
 * @property {number} index position in the file's section list
 * @property {string} name the variation name, trimmed
 * @property {Uint8Array} nameBytes the name exactly as stored, padding included
 * @property {SectionRecord[]} records
 * @property {number} channels sorted, unique channel numbers
 * @property {number} offset absolute offset of the CSEG chunk header
 * @property {number} length the CSEG chunk's declared length
 *
 * @typedef {object} Casm
 * @property {number} offset absolute offset of the CASM chunk header
 * @property {number} length the CASM chunk's declared length
 * @property {Section[]} sections
 */

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
  // is over top-level chunks only. Descending into a chunk that merely happens to
  // contain the letters CASM would be reading a coincidence.
  let p = 0;
  while (p + 8 <= bytes.byteLength) {
    const id = chunkId(bytes, p);
    const length = chunkLength(view, p);
    if (id === 'CASM') return readCasmBody(bytes, view, p, length);
    if (length === 0) break;
    p += 8 + length;
  }
  return null;
}

/** Parse the CSEG children of a CASM chunk. */
function readCasmBody(bytes, view, casmOffset, casmLength) {
  const bodyStart = casmOffset + 8;
  const bodyEnd = casmOffset + 8 + casmLength;
  /** @type {Section[]} */
  const sections = [];
  let p = bodyStart;
  let index = 0;

  while (p + 8 <= bodyEnd) {
    const id = chunkId(bytes, p);
    const length = chunkLength(view, p);
    if (id !== 'CSEG') {
      // An unknown sibling is skipped rather than guessed at, but its absence is
      // reported by `trailing` so a caller can tell "clean" from "gave up".
      if (length === 0) break;
      p += 8 + length;
      continue;
    }
    const section = readCseg(bytes, view, p, length, index);
    sections.push(section);
    p += 8 + length;
    index++;
  }

  return {
    offset: casmOffset,
    length: casmLength,
    sections,
    // Bytes inside CASM that were not CSEG children. Non-zero means the layout is
    // not the one this module claims to understand.
    trailing: bodyEnd - p,
  };
}

/** Parse one CSEG group: its name, then its fixed-width voice records. */
function readCseg(bytes, view, csegOffset, csegLength, index) {
  const bodyStart = csegOffset + 8;
  const bodyEnd = csegOffset + 8 + csegLength;
  if (chunkId(bytes, bodyStart) !== 'Sdec') {
    throw new Error(`CSEG ${index} does not begin with an Sdec chunk`);
  }
  const sdecLength = chunkLength(view, bodyStart);
  // The name text starts after the Sdec header. It is not NUL-terminated; it is
  // space-padded to the declared length, so it has to be trimmed for display but
  // kept whole for writing back.
  const nameBytes = bytes.slice(bodyStart + 8, bodyStart + 8 + sdecLength);

  /** @type {SectionRecord[]} */
  const records = [];
  let p = bodyStart + 8 + sdecLength;
  let recordIndex = 0;
  while (p + RECORD_LENGTH <= bodyEnd) {
    // A record is only a record if it announces itself with the 0x2F marker.
    if (bytes[p + TAG_LENGTH] !== 0x2f) {
      throw new Error(
        `CSEG ${index} record ${recordIndex} has no 0x2F marker at ${p + TAG_LENGTH}`,
      );
    }
    const channel = bytes[p + TAG_LENGTH + 1];
    const name = cleanName(bytes.subarray(p + TAG_LENGTH + 2, p + TAG_LENGTH + 2 + NAME_LENGTH));
    records.push({
      index: recordIndex,
      channel,
      name,
      tag: bytes.slice(p, p + TAG_LENGTH),
      params: bytes.slice(p + TAG_LENGTH + 2 + NAME_LENGTH, p + RECORD_LENGTH),
    });
    p += RECORD_LENGTH;
    recordIndex++;
  }

  if (p !== bodyEnd) {
    throw new Error(
      `CSEG ${index} has ${bodyEnd - p} trailing bytes that are not a whole 55-byte record`,
    );
  }

  return {
    index,
    name: cleanName(nameBytes),
    nameBytes,
    records,
    channels: [...new Set(records.map((r) => r.channel))].sort((a, b) => a - b),
    offset: csegOffset,
    length: csegLength,
  };
}

/**
 * Rebuild a CASM chunk body from its sections.
 *
 * @param {Section[]} sections
 * @returns {Uint8Array}
 */
export function buildCasmBody(sections) {
  const total = sections.reduce((sum, s) => sum + 8 + 8 + s.nameBytes.length
    + s.records.length * RECORD_LENGTH, 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let p = 0;

  for (const section of sections) {
    out[p] = 0x43; out[p + 1] = 0x53; out[p + 2] = 0x45; out[p + 3] = 0x47; // "CSEG"
    view.setUint32(p + 4, 8 + section.nameBytes.length + section.records.length * RECORD_LENGTH);
    p += 8;

    out[p] = 0x53; out[p + 1] = 0x64; out[p + 2] = 0x65; out[p + 3] = 0x63; // "Sdec"
    view.setUint32(p + 4, section.nameBytes.length);
    p += 8;
    out.set(section.nameBytes, p);
    p += section.nameBytes.length;

    for (const record of section.records) {
      out.set(record.tag, p);
      out[p + TAG_LENGTH] = 0x2f;
      out[p + TAG_LENGTH + 1] = record.channel;
      const name = record.nameBytes ?? paddedName(record.name);
      out.set(name, p + TAG_LENGTH + 2);
      out.set(record.params, p + TAG_LENGTH + 2 + NAME_LENGTH);
      p += RECORD_LENGTH;
    }
  }
  return out;
}

/** A part name padded to the fixed width the format stores it in. */
function paddedName(name) {
  const out = new Uint8Array(NAME_LENGTH).fill(0x20);
  for (let i = 0; i < Math.min(NAME_LENGTH, name.length); i++) {
    out[i] = name.charCodeAt(i) & 0x7f;
  }
  return out;
}

/** A variation name padded the way Sdec stores one. */
function paddedSectionName(name) {
  const out = new Uint8Array(name.length).fill(0x20);
  for (let i = 0; i < name.length; i++) out[i] = name.charCodeAt(i) & 0x7f;
  return out;
}

/**
 * Replace a file's CASM chunk with a rebuilt one.
 *
 * CASM sits at the top level in these files, so the only length to correct is its
 * own. Everything else in the file - the tracks, the voice parameter tables, the
 * notes - is copied through byte for byte.
 *
 * @param {ArrayBuffer} buffer
 * @param {Casm} casm as returned by parseCasm, possibly modified
 * @returns {ArrayBuffer} a new buffer; the input is not touched
 */
export function writeCasm(buffer, casm) {
  const src = new Uint8Array(buffer);
  const before = src.slice(0, casm.offset);
  const after = src.slice(casm.offset + 8 + casm.length);
  const body = buildCasmBody(casm.sections);

  const chunk = new Uint8Array(8 + body.length);
  chunk[0] = 0x43; chunk[1] = 0x41; chunk[2] = 0x53; chunk[3] = 0x4d; // "CASM"
  new DataView(chunk.buffer).setUint32(4, body.length);
  chunk.set(body, 8);

  const out = new Uint8Array(before.length + chunk.length + after.length);
  out.set(before, 0);
  out.set(chunk, before.length);
  out.set(after, before.length + chunk.length);
  return out.buffer;
}

/**
 * Turn a part on or off inside one variation.
 *
 * Switching a part off removes its record, so the arranger no longer lists that
 * channel for that section. Switching it on puts it back. When the channel
 * already has a record in some other variation, its parameters are copied from
 * there - they describe the voice, not the section, and inventing zeros would
 * leave the part unplayable rather than merely silent.
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
  const at = section.records.findIndex((r) => r.channel === channel);

  if (!on) {
    if (at < 0) return { ok: false, reason: 'that part is already off in this section' };
    section.records.splice(at, 1);
    section.channels = [...new Set(section.records.map((r) => r.channel))].sort((a, b) => a - b);
    return { ok: true };
  }

  if (at >= 0) return { ok: false, reason: 'that part is already on in this section' };
  const donor = findDonorRecord(casm, channel);
  if (!donor) {
    return { ok: false, reason: 'no other variation uses that channel, so there are no voice settings to copy' };
  }
  section.records.push({
    index: section.records.length,
    channel,
    name: donor.name,
    nameBytes: donor.nameBytes ?? paddedName(donor.name),
    tag: donor.tag.slice(),
    params: donor.params.slice(),
  });
  section.records.sort((a, b) => a.channel - b.channel);
  section.records.forEach((r, i) => { r.index = i; });
  section.channels = [...new Set(section.records.map((r) => r.channel))].sort((a, b) => a - b);
  return { ok: true };
}

/** The same channel's record from any other section, used as a template. */
function findDonorRecord(casm, channel) {
  for (const section of casm.sections) {
    const hit = section.records.find((r) => r.channel === channel);
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
 * The copy is deliberate rather than an empty shell: the record's 38 parameter
 * bytes are the only description of how that part is set up, and a new variation
 * with none of them would list a part the arranger cannot play. Editing the copy
 * afterwards - switching parts off, renaming it - is the normal way to use this.
 *
 * @param {Casm} casm modified in place
 * @param {number} afterIndex insert after this section; -1 puts it first
 * @param {string} [name]
 */
export function cloneSection(casm, afterIndex, name) {
  const source = casm.sections[afterIndex];
  if (!source) return { ok: false, reason: 'no such section' };
  const at = afterIndex + 1;
  const copy = {
    index: at,
    name: name ?? nextFreeName(casm, source.name),
    nameBytes: null,
    records: source.records.map((r, i) => ({
      index: i,
      channel: r.channel,
      name: r.name,
      tag: r.tag.slice(),
      params: r.params.slice(),
    })),
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

export { RECORD_LENGTH, NAME_LENGTH, PARAMS_LENGTH, TAG_LENGTH };

// ---- replayable edits --------------------------------------------------------

/**
 * Map edits are kept as a list of intentions rather than as a mutated structure.
 *
 * Two reasons, and both are about correctness rather than tidiness. The first is
 * that a note-length edit elsewhere in the file changes the byte offset CASM sits
 * at, so the parse these edits were made against is stale by the time the file is
 * written. The second is that reverting has to be exact: replaying an empty list
 * onto a fresh parse restores the original map without keeping a second copy of
 * the file around to compare against.
 *
 * Each operation names its section by name rather than by index, because deleting
 * a section renumbers the ones after it and an index would then point somewhere
 * else entirely.
 *
 * @typedef {{op: 'channel', section: string, channel: number, on: boolean}
 *   | {op: 'rename', section: string, name: string}
 *   | {op: 'remove', section: string}
 *   | {op: 'clone', after: string, name?: string}} CasmOperation
 */

/** Find a section by name, tolerating the case where names repeat. */
function findSection(casm, name) {
  return casm.sections.find((s) => s.name === name) ?? null;
}

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
  return { ok: false, reason: `unknown operation ${operation.op}` };
}

/**
 * Apply a whole list, stopping at the first thing that cannot be done.
 *
 * Stopping matters: an operation that half-applied would leave a map the user
 * never asked for, and the file would still be written.
 *
 * @param {Casm} casm modified in place
 * @param {CasmOperation[]} operations
 * @returns {{ok: boolean, applied: number, reason?: string}}
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
 * @returns {{casm: Casm|null, applied: number, reason?: string}}
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
 * per channel rather than overwritten, and the caller can show that a part's role
 * is not the same everywhere.
 *
 * @param {Casm} casm
 * @returns {{channel: number, names: string[], sections: number}[]}
 */
export function styleParts(casm) {
  /** @type {Map<number, {names: Set<string>, sections: Set<number>}>} */
  const byChannel = new Map();
  for (const section of casm.sections) {
    for (const record of section.records) {
      const entry = byChannel.get(record.channel) ?? { names: new Set(), sections: new Set() };
      entry.names.add(record.name);
      entry.sections.add(section.index);
      byChannel.set(record.channel, entry);
    }
  }
  return [...byChannel.entries()]
    .map(([channel, entry]) => ({
      channel,
      names: [...entry.names],
      sections: entry.sections.size,
    }))
    .sort((a, b) => a.channel - b.channel);
}
