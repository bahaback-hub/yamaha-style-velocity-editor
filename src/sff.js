/**
 * Yamaha SFF container reader.
 *
 * A .STY file is an SFF container: a small header followed by a flat list of
 * chunks, each a 4-character id plus a 4-byte big-endian length. The musical
 * payload lives in nested chunks, so reading the payload means walking two
 * levels rather than trusting an offset table.
 *
 * Everything here is offset-based and non-destructive. Nothing rewrites a file;
 * callers get byte offsets and slice their own views. That is deliberate: the
 * only safe way to edit a style is to change the bytes you mean and leave every
 * other byte exactly as it was.
 */

const SFF_MAGIC = [0x53, 0x46, 0x46, 0x20]; // "SFF "
const SFF2_MAGIC = [0x53, 0x46, 0x46, 0x32]; // "SFF2"
const SMF_MAGIC = [0x4d, 0x54, 0x68, 0x64]; // "MThd"

/**
 * Bytes [start, end) of a DataView as a string.
 *
 * A DataView is not a buffer: `new Uint8Array(view, start, len)` silently yields
 * an empty array, because the TypedArray constructor only takes an
 * ArrayBuffer as its first argument. Every read here has to go through
 * view.buffer and add view.byteOffset, or it returns nothing without throwing.
 */
const text = (view, start, end) =>
  String.fromCharCode(...new Uint8Array(view.buffer, view.byteOffset + start, end - start));

/** @typedef {{id: string, start: number, length: number, dataStart: number, headerStart: number}} Chunk */

/**
 * @param {DataView} view
 * @param {number} start offset of the first chunk
 * @param {number} end   exclusive upper bound
 * @returns {Chunk[]}
 */
export function readChunks(view, start, end) {
  /** @type {Chunk[]} */
  const out = [];
  let p = start;
  while (p + 8 <= end) {
    const id = text(view, p, p + 4);
    const length = view.getUint32(p + 4);
    const dataStart = p + 8;
    // A length that runs past the end means the walk is desynchronised. Stop
    // rather than emit a chunk whose dataStart is nonsense: a wrong offset is
    // how you corrupt a file.
    if (length > end - dataStart) {
      break;
    }
    out.push({ id, start: p, length, dataStart, headerStart: p });
    p = dataStart + length;
  }
  return out;
}

/**
 * Read the top-level SFF header.
 *
 * SFF and SFF2 differ in whether a 4-byte length follows the magic. SFF2
 * (PSR-A5000, Genos and later) carries that length; SFF1 does not. Both are
 * accepted so the tool is not limited to one generation of arranger.
 *
 * @param {ArrayBuffer} buffer
 */
export function readSff(buffer) {
  const view = new DataView(buffer);
  const magic = [view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3)];
  const isSff2 = magic.every((b, i) => b === SFF2_MAGIC[i]);
  const isSff1 = magic.every((b, i) => b === SFF_MAGIC[i]);
  const isSmf = magic.every((b, i) => b === SMF_MAGIC[i]);
  if (!isSff1 && !isSff2 && !isSmf) {
    const seen = String.fromCharCode(...magic).replace(/[^\x20-\x7e]/g, '?');
    throw new Error(`Not a Yamaha SFF or MIDI file (header reads "${seen}").`);
  }

  // A bare Standard MIDI File with a .STY extension is a real thing in the
  // wild: exported style parts and several editor utilities produce one, with
  // the drum performance in plain MTrk chunks. Treating the whole file as a
  // single payload is the only correct reading - there is no container to walk.
  const smfFormat = isSmf ? view.getUint16(8) : -1;
  const smfTracks = isSmf ? view.getUint16(10) : -1;

  let cursor;
  if (isSmf) {
    cursor = 0;
  } else if (isSff2) {
    // SFF2 stores the header length as a 4-byte big-endian value AFTER the
    // magic, and that length counts the four length bytes themselves - a
    // declared 8 means 8 bytes of header total, i.e. 4 remaining after the
    // magic and 4 already consumed as the length field. Adding the raw value
    // to 8 skips four bytes too far and lands mid-chunk.
    const declared = view.getUint32(4);
    const afterLength = declared >= 4 ? declared - 4 : 0;
    cursor = 8 + afterLength;
  } else {
    // SFF1 has no length field: the chunk list starts immediately after the
    // four magic bytes.
    cursor = 4;
  }
  // Clamp: a corrupt length must not push the walk past the buffer.
  if (cursor < 4 || cursor > view.byteLength) {
    cursor = isSff2 ? 8 : 4;
  }

  let chunks = readChunks(view, cursor, view.byteLength);
  if (chunks.length === 0 && isSff2) {
    // Some writers put a length field in an SFF2 file that SFF1 tooling would
    // not expect. Falling back to the SFF1 layout keeps those files readable
    // instead of reporting a valid file as having no MIDI data at all.
    chunks = readChunks(view, 4, view.byteLength);
  }
  return { view, isSff2, isSmf, smfFormat, smfTracks, chunks };
}

/**
 * Locate the MIDI payloads.
 *
 * A style carries the same performance twice:
 *   - `MID` is the cached copy as it was authored.
 *   - `MER` is the merged copy the arranger plays back.
 *
 * Newer models read `MER` when present and older ones read `MID`, so a velocity
 * edit applied to only one of them can sound unchanged on half the hardware in
 * the family. Both are returned, and the caller patches every payload found.
 *
 * @param {ArrayBuffer} buffer
 * @returns {{version: 'SFF1'|'SFF2', payloadSize: number, payloads: {kind: string, offset: number, size: number, format: number, tracks: number}[]}}
 */
export function findMidiPayloads(buffer) {
  const { view, isSff2, isSmf, smfFormat, smfTracks, chunks } = readSff(buffer);
  /** @type {{kind: string, offset: number, size: number, format: number, tracks: number}[]} */
  const payloads = [];

  // A bare SMF: the whole file is the payload. Its length is the buffer, not a
  // chunk length, and indexNotes stops at the last MTrk so any trailing
  // proprietary chunk (CASM and friends) is ignored rather than misread.
  if (isSmf) {
    payloads.push({
      kind: 'SMF',
      offset: 0,
      size: view.byteLength,
      format: smfFormat,
      tracks: smfTracks,
    });
    return { version: 'MIDI', container: 'bare-smf', payloadSize: view.byteLength, payloads };
  }

  for (const chunk of chunks) {
    if (chunk.id !== 'Smed') continue;
    // Walk inside Smed for MID / MER.
    for (const inner of readChunks(view, chunk.dataStart, chunk.dataStart + chunk.length)) {
      // Three-character ids are null-padded to four bytes on disk ("MID\0"),
      // so compare on the trimmed id rather than the raw four bytes.
      const id = inner.id.replace(/\0+$/, '');
      if (id !== 'MID' && id !== 'MER') continue;
      const offset = inner.dataStart;
      // Peek the embedded Standard MIDI File so callers can skip non-MIDI junk
      // without parsing the whole track list.
      let format = -1;
      let tracks = -1;
      if (offset + 14 <= view.byteLength) {
        const head = text(view, offset, offset + 4);
        if (head === 'MThd') {
          format = view.getUint16(offset + 8);
          tracks = view.getUint16(offset + 10);
        }
      }
      payloads.push({ kind: id, offset, size: inner.length, format, tracks });
    }
  }

  return {
    version: isSff2 ? 'SFF2' : 'SFF1',
    container: 'sff',
    payloadSize: payloads.reduce((a, p) => a + p.size, 0),
    payloads,
  };
}
