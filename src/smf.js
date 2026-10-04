/**
 * Standard MIDI File parsing, scoped to what a velocity edit needs.
 *
 * A style's payload is an ordinary SMF, so note events are found the ordinary
 * way: walk each track, decode delta-times, and recognise the channel voice
 * messages. What makes this fiddly rather than trivial is the three encodings
 * that all terminate or continue differently:
 *
 *   - running status: a data byte whose top bit is clear reuses the last
 *     status byte, so a track can be a run of bare note numbers;
 *   - meta events (0xFF) carry a variable-length length that must be skipped
 *     whole, or the parser desynchronises and starts inventing notes;
 *   - sysex (0xF0/0xF7) also carries a length and can span the whole track.
 *
 * Every note is recorded as an absolute file offset plus the exact position of
 * its velocity byte, so the patcher can write one byte and touch nothing else.
 */

/** MIDI note number -> scientific pitch, with the full 0-127 range. */
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/**
 * @param {number} note 0-127
 * @returns {string} e.g. "C2", "A#4"
 */
export function noteName(note) {
  return `${NAMES[note % 12]}${Math.floor(note / 12) - 1}`;
}

export const CHANNEL_NAMES = [
  'Right 1', 'Right 2', 'Left 1', 'Left 2',
  'Right 3', 'Left 3', 'Right 4', 'Left 4',
  'Right 5', 'Left 5', 'Right 6', 'Left 6',
  'Right 7', 'Right 8', 'Right 9', 'Right 10',
];

/** @param {number} ch 0-15 */
export function channelName(ch) {
  return CHANNEL_NAMES[ch] ?? `Channel ${ch + 1}`;
}

/**
 * Decode a variable-length quantity at `p`. Returns the value and the offset of
 * the first byte after it.
 * @returns {{value: number, next: number} | null}
 */
export function readVarLen(view, p, limit) {
  let value = 0;
  let cursor = p;
  let guard = 0;
  while (cursor < limit && guard < 4) {
    const b = view.getUint8(cursor);
    value = (value << 7) | (b & 0x7f);
    cursor++;
    guard++;
    if ((b & 0x80) === 0) return { value, next: cursor };
  }
  return null;
}

/**
 * Index every note-on event in an SMF payload.
 *
 * @param {ArrayBuffer} buffer
 * @param {number} payloadOffset absolute offset of the SMF inside the file
 * @param {number} payloadSize
 * @returns {{notes: NoteHit[], tracks: number, division: number, error?: string}}
 *
 * @typedef {object} NoteHit
 * @property {number} velocityOffset absolute file offset of the velocity byte
 * @property {number} velocity current velocity, 0-127
 * @property {number} note 0-127
 * @property {number} channel 0-15
 * @property {number} track
 * @property {number} tick delta-time in ticks
 */
export function indexNotes(buffer, payloadOffset, payloadSize) {
  const view = new DataView(buffer);
  /** @type {NoteHit[]} */
  const notes = [];
  const limit = payloadOffset + payloadSize;

  if (payloadOffset + 14 > limit) {
    return { notes, tracks: 0, division: 0, error: 'payload too short for an SMF header' };
  }
  if (str(view, payloadOffset, payloadOffset + 4) !== 'MThd') {
    return { notes, tracks: 0, division: 0, error: 'payload is not an SMF (no MThd)' };
  }

  const division = view.getUint16(payloadOffset + 12);

  let p = payloadOffset + 8 + view.getUint32(payloadOffset + 4);
  let trackIndex = 0;

  while (p + 8 <= limit && str(view, p, p + 4) === 'MTrk') {
    const trackLen = view.getUint32(p + 4);
    const trackStart = p + 8;
    const trackEnd = trackStart + trackLen;
    if (trackEnd > limit) break;

    let cursor = trackStart;
    let status = 0;

    while (cursor < trackEnd) {
      const delta = readVarLen(view, cursor, trackEnd);
      if (!delta) break;
      cursor = delta.next;
      const tick = delta.value;

      let b = view.getUint8(cursor);
      if (b < 0x80) {
        // Running status: reuse the previous status byte.
        if (status === 0) break;
        b = status;
      } else {
        cursor++;
        if (b < 0xf0) {
          status = b;
        } else if (b === 0xff) {
          // Meta event: skip type + length + body.
          const type = view.getUint8(cursor);
          cursor++;
          const len = readVarLen(view, cursor, trackEnd);
          if (!len) break;
          cursor = len.next + len.value;
          if (cursor > trackEnd) break;
          void type;
          continue;
        } else if (b === 0xf0 || b === 0xf7) {
          const len = readVarLen(view, cursor, trackEnd);
          if (!len) break;
          cursor = len.next + len.value;
          if (cursor > trackEnd) break;
          continue;
        } else {
          // System realtime / other: no running status to carry.
          status = 0;
          continue;
        }
      }

      const type = b & 0xf0;
      if (type === 0x90 || type === 0x80) {
        if (cursor + 1 >= trackEnd) break;
        const note = view.getUint8(cursor);
        const velocity = view.getUint8(cursor + 1);
        if (type === 0x90 && velocity > 0) {
          notes.push({
            // cursor is already an absolute file offset: the walk starts at
            // payloadOffset and never rebases. Adding payloadOffset again
            // shifts every write into the wrong byte.
            velocityOffset: cursor + 1,
            velocity,
            note,
            channel: b & 0x0f,
            track: trackIndex,
            tick,
          });
        }
        cursor += 2;
      } else {
        // Program change and channel pressure carry one data byte.
        cursor += type === 0xc0 || type === 0xd0 ? 1 : 2;
      }
      if (cursor > trackEnd) break;
    }

    p = trackEnd;
    trackIndex++;
  }

  return { notes, tracks: trackIndex, division };
}

function str(view, start, end) {
  // A DataView is not a buffer - see the note in sff.js.
  return String.fromCharCode(...new Uint8Array(view.buffer, view.byteOffset + start, end - start));
}

/**
 * Patch velocities in place.
 *
 * Writes exactly one byte per matching note into a copy of the input. Every
 * other byte, including the SFF header, chunk lengths and all metadata, is
 * carried over verbatim, because Yamaha players validate the container and will
 * refuse a style whose declared lengths disagree with its contents.
 *
 * @param {ArrayBuffer} buffer
 * @param {{velocityOffset: number, velocity: number}[]} targets
 * @param {number} velocity 1-127
 * @returns {ArrayBuffer}
 */
export function applyVelocity(buffer, targets, velocity) {
  const clamped = Math.max(1, Math.min(127, Math.round(velocity)));
  // slice() copies. `new Uint8Array(buffer)` does NOT: constructing a view over
  // an existing ArrayBuffer aliases it, so the write would land in the user's
  // original file - and with it, the bytes we promised not to touch.
  const copy = buffer.slice(0);
  const out = new Uint8Array(copy);
  const view = new DataView(copy);
  for (const t of targets) {
    if (t.velocityOffset < 0 || t.velocityOffset >= out.byteLength) continue;
    view.setUint8(t.velocityOffset, clamped);
  }
  return copy;
}
