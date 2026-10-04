/**
 * Track re-serialiser.
 *
 * Velocity and pitch are single-byte writes and never move anything. Length is
 * not: a note's length is expressed as the delta-time before its note-off, and
 * delta-times are variable-length. Making a note longer can push a delta from one
 * byte to two, which shifts every byte after it, which invalidates the MTrk
 * length, the enclosing Smed length and the container's own chunk lengths.
 *
 * So length editing means re-emitting the track. That is only safe if the
 * serialiser is exact, and the way to prove that is a round trip: parse a track,
 * write it straight back with nothing changed, and require the result to be
 * byte-for-byte identical to the input. That test is the contract for everything
 * else in this file - if it holds, edits built on top of the same emitter are
 * sound, and if it ever fails, no length edit should be trusted.
 *
 * The parser records each event's absolute tick and its raw bytes. Re-emitting
 * walks the same list, recomputes deltas, and writes variable-length values with
 * the canonical minimal encoding.
 */

/** Encode a variable-length quantity, the same minimal form the format expects. */
export function writeVarLen(value) {
  if (value < 0) throw new RangeError(`delta-time cannot be negative: ${value}`);
  const out = [value & 0x7f];
  let v = value >> 7;
  while (v > 0) {
    out.push((v & 0x7f) | 0x80);
    v >>= 7;
  }
  return out.reverse();
}

/** Bytes needed to encode a delta-time. */
export function varLenSize(value) {
  return writeVarLen(value).length;
}

/**
 * @typedef {object} TrackEvent
 * @property {'note-on'|'note-off'|'meta'|'sysex'|'other'} kind
 * @property {number} tick absolute tick within the track
 * @property {number[]} bytes the event's bytes, excluding the delta-time
 * @property {number} [pitchIndex] index of the pitch byte within `bytes`
 */

/**
 * Re-emit a parsed track.
 *
 * @param {TrackEvent[]} events in file order
 * @returns {Uint8Array} the MTrk body, without the "MTrk" chunk header
 */
export function serialiseTrack(events) {
  /** @type {number[]} */
  const out = [];
  let cursor = 0;
  for (const event of events) {
    const delta = event.tick - cursor;
    // Several events can legitimately share a tick - a meta event and the note
    // that follows it, or a run of notes under running status all at tick 0.
    // Negative would mean the caller reordered the list, which is a real error.
    if (delta < 0) throw new RangeError(`events out of order at tick ${event.tick}`);
    out.push(...writeVarLen(delta));
    out.push(...event.bytes);
    cursor = event.tick;
  }
  return Uint8Array.from(out);
}

/**
 * Replace a track inside a payload and fix every length field above it.
 *
 * @param {ArrayBuffer} buffer the whole file
 * @param {{payloadOffset: number, trackStart: number, trackLength: number, headerSize: number}} where trackStart is the offset of the "MTrk" id
 * @param {Uint8Array} newTrackBody
 * @returns {ArrayBuffer} a new buffer; the input is not modified
 */
export function replaceTrack(buffer, where, newTrackBody) {
  const src = new Uint8Array(buffer);
  const before = src.slice(0, where.trackStart);
  const after = src.slice(where.trackStart + where.headerSize + where.trackLength);

  const header = Uint8Array.from([0x4d, 0x54, 0x72, 0x6b]); // "MTrk"
  const chunk = new Uint8Array(8 + newTrackBody.length);
  chunk.set(header, 0);
  const len = newTrackBody.length;
  chunk[4] = (len >>> 24) & 0xff;
  chunk[5] = (len >>> 16) & 0xff;
  chunk[6] = (len >>> 8) & 0xff;
  chunk[7] = len & 0xff;
  chunk.set(newTrackBody, 8);

  const delta = chunk.length - (where.headerSize + where.trackLength);
  const out = new Uint8Array(before.length + chunk.length + after.length);
  out.set(before, 0);
  out.set(chunk, before.length);
  out.set(after, before.length + chunk.length);

  if (delta !== 0) {
    const patched = fixContainerLengths(out, where, delta);
    return patched;
  }
  return out.buffer;
}

/**
 * Walk up from the rewritten track and adjust every enclosing chunk length.
 *
 * The chain differs by container shape: in a bare MIDI there is nothing above the
 * track, while in an SFF style the track sits inside MID or MER, which sits inside
 * Smed, and Smed is a top-level chunk of the file. Every one of those declares a
 * length, and every one of them has to grow by the same delta. Missing a link
 * leaves a container declaring less data than it holds, and players reject the
 * file.
 *
 * @param {Uint8Array} bytes
 * @param {{payloadOffset: number}} where
 * @param {number} delta signed change in the track's byte length
 */
function fixContainerLengths(bytes, where, delta) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // Innermost chunk first, so each level is corrected before the one around it.
  const chain = chunkChainAt(bytes, topLevelStart(bytes, view), bytes.length, where.payloadOffset);
  for (const headerStart of chain) adjust(view, headerStart, delta);

  return bytes.buffer;
}

/** Add `delta` to the 4-byte big-endian length at `headerStart`. */
function adjust(view, headerStart, delta) {
  const current = view.getUint32(headerStart + 4);
  const next = current + delta;
  if (next < 0) throw new RangeError('chunk length would go negative');
  view.setUint32(headerStart + 4, next >>> 0);
}

/**
 * Offset of the first top-level chunk.
 *
 * A bare SMF opens with MThd, whose length field says how much follows it. An SFF
 * container has no such field for the whole file - its header declares only its
 * own size, so chunks start right after that.
 */
function topLevelStart(bytes, view) {
  const magic = String.fromCharCode(...bytes.subarray(0, 4));
  if (magic === 'MThd') return 8 + view.getUint32(4);
  if (magic.endsWith('2')) return 8 + Math.max(0, view.getUint32(4) - 4);
  return 4;
}

/**
 * Find every chunk header that encloses an offset, innermost first.
 *
 * Containers nest - an Smed chunk holds MID or MER, which holds the MTrk - so a
 * flat scan of the top level would find Smed and stop, never noticing the MID
 * length underneath it. Recursing into each chunk's payload finds the whole chain.
 *
 * @param {Uint8Array} bytes
 * @param {number} start where chunks begin at this level
 * @param {number} end end of the region this level may read
 * @param {number} target the offset to enclose
 * @returns {number[]} header offsets, innermost first; empty if none enclose it
 */
function chunkChainAt(bytes, start, end, target) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let p = start;
  while (p + 8 <= end) {
    const len = view.getUint32(p + 4);
    if (target > p && target < p + 8 + len) {
      // This chunk holds the target. Look one level deeper before settling for it.
      const dataStart = p + 8;
      const dataEnd = Math.min(p + 8 + len, bytes.length);
      const nested = chunkChainAt(bytes, dataStart, dataEnd, target);
      if (nested.length > 0) {
        nested.push(p);
        return nested;
      }
      return [p];
    }
    // A zero-length chunk would leave `p` where it is and spin forever.
    if (len === 0) return [];
    p += 8 + len;
  }
  return [];
}
