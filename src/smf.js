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
 * Besides offsets and velocities, this collects what a viewer needs in order to
 * place notes in time and play them back:
 *   - `at` is the absolute tick, not the delta, so notes can be ordered and
 *     laid out without the caller re-walking the track;
 *   - `durationTicks` comes from matching each note-off, so playback knows how
 *     long to hold a note;
 *   - `tempoMap` records every set-tempo meta event, because tempo can change
 *     mid-track and a single tempo value would drift audibly;
 *   - `timeSignature` drives bar numbering.
 *
 * @param {ArrayBuffer} buffer
 * @param {number} payloadOffset absolute offset of the SMF inside the file
 * @param {number} payloadSize
 * @returns {{notes: NoteHit[], tracks: number, division: number, layout: 'smf'|'tracks-only', tempoMap: TempoPoint[], timeSignature: TimeSignature, lengthTicks: number, error?: string}}
 *
 * @typedef {object} NoteHit
 * @property {number} velocityOffset absolute file offset of the velocity byte
 * @property {number} velocity current velocity, 0-127
 * @property {number} note 0-127
 * @property {number} channel 0-15
 * @property {number} track
 * @property {number} tick delta-time in ticks (kept for reference)
 * @property {number} at absolute tick from the start of the payload
 * @property {number} durationTicks 0 when no note-off was found
 * @property {number} pitchOffset absolute file offset of the note-on pitch byte
 * @property {number} [releasePitchOffset] absolute file offset of the note-off pitch byte
 * @property {number} [releaseAt] absolute tick of the note-off
 * @property {number} openEventIndex index of this note's note-on in trackList[].events
 * @property {number} closeEventIndex index of its note-off, or -1 when it hangs
 *
 * @typedef {object} TrackEvent
 * @property {'note-on'|'note-off'|'meta'|'sysex'|'other'} kind
 * @property {number} tick absolute tick within the track
 * @property {number[]} bytes the event's bytes, excluding the delta-time
 * @property {number} [pitchIndex] index of the pitch byte within `bytes`
 *
 * @typedef {{tick: number, usPerQuarter: number}} TempoPoint
 * @typedef {{numerator: number, denominator: number}} TimeSignature
 */
export function indexNotes(buffer, payloadOffset, payloadSize) {
  const view = new DataView(buffer);
  /** @type {NoteHit[]} */
  const notes = [];
  const limit = payloadOffset + payloadSize;
  const empty = (error) => ({
    notes,
    tracks: 0,
    division: 0,
    layout: 'smf',
    tempoMap: [],
    timeSignature: { numerator: 4, denominator: 4 },
    lengthTicks: 0,
    error,
  });

  if (payloadOffset + 8 > limit) return empty('payload too short for an SMF header');
  if (str(view, payloadOffset, payloadOffset + 4) !== 'MThd') {
    return empty('payload is not an SMF (no MThd)');
  }

  const division = view.getUint16(payloadOffset + 12);
  /** @type {TempoPoint[]} */
  const tempoMap = [{ tick: 0, usPerQuarter: 500000 }];
  /** @type {TimeSignature} */
  let timeSignature = { numerator: 4, denominator: 4 };

  let p = payloadOffset + 8 + view.getUint32(payloadOffset + 4);
  let trackIndex = 0;
  let lengthTicks = 0;
  // Note-ons still waiting for their note-off, keyed by channel and pitch.
  // Yamaha writes overlapping same-pitch hits on the drum channels, so the
  // oldest is released first - which is what a player does too.
  /** @type {Map<string, NoteHit[]>} */
  const pending = new Map();
  /** Raw events per track, so a track can be re-emitted byte-for-byte. */
  /** @type {{events: TrackEvent[], trackIndex: number, start: number, length: number}[]} */
  const trackList = [];

  while (p + 8 <= limit && str(view, p, p + 4) === 'MTrk') {
    const trackLen = view.getUint32(p + 4);
    const trackStart = p + 8;
    const trackEnd = trackStart + trackLen;
    if (trackEnd > limit) break;

    let cursor = trackStart;
    let status = 0;
    let abs = 0;
    /** @type {TrackEvent[]} */
    const events = [];

    while (cursor < trackEnd) {
      const delta = readVarLen(view, cursor, trackEnd);
      if (!delta) break;
      cursor = delta.next;
      const tick = delta.value;
      abs += tick;
      if (abs > lengthTicks) lengthTicks = abs;

      let b = view.getUint8(cursor);
      // Whether this event spelled out its own status byte. Under running status
      // the status is omitted from the file entirely, so a re-emitter must not
      // invent one - the raw bytes are copied back out and any extra byte would
      // change the track's length and every delta after it. It also decides where
      // the pitch byte sits, so the flag has to be right in both directions.
      let hasStatus = true;
      if (b < 0x80) {
        // Running status: reuse the previous status byte.
        if (status === 0) break;
        b = status;
        hasStatus = false;
      } else {
        cursor++;
        if (b < 0xf0) {
          status = b;
        } else if (b === 0xff) {
          // cursor has already advanced past the 0xff, so the event's first byte
          // is one further back. Copying from here instead would drop the 0xff
          // and produce a meta event the next reader would not recognise.
          const startByte = cursor - 1;
          const type = view.getUint8(cursor);
          cursor++;
          const len = readVarLen(view, cursor, trackEnd);
          if (!len) break;
          // The body starts *after* the variable-length length field. Reading it
          // from `cursor` points at the length bytes themselves, which silently
          // yields a nonsense tempo and time signature.
          const body = len.next;
          const end = body + len.value;
          cursor = end;
          if (cursor > trackEnd) break;
          if (type === 0x51 && len.value === 3) {
            const usPerQuarter =
              (view.getUint8(body) << 16) | (view.getUint8(body + 1) << 8) | view.getUint8(body + 2);
            // A tempo declared at tick 0 is the real one, not a second opinion.
            if (abs === 0) tempoMap[0] = { tick: 0, usPerQuarter };
            else tempoMap.push({ tick: abs, usPerQuarter });
          } else if (type === 0x58 && len.value >= 2) {
            const denom = view.getUint8(body + 1);
            timeSignature = {
              numerator: view.getUint8(body),
              denominator: denom > 0 && denom < 16 ? 2 ** denom : 4,
            };
          }
          events.push({
            kind: 'meta',
            tick: abs,
            bytes: Array.from(new Uint8Array(view.buffer, view.byteOffset + startByte, cursor - startByte)),
          });
          continue;
        } else if (b === 0xf0 || b === 0xf7) {
          // Same one-byte-back rule as the meta case: cursor is past the 0xF0.
          const startByte = cursor - 1;
          const len = readVarLen(view, cursor, trackEnd);
          if (!len) break;
          cursor = len.next + len.value;
          if (cursor > trackEnd) break;
          events.push({
            kind: 'sysex',
            tick: abs,
            bytes: Array.from(new Uint8Array(view.buffer, view.byteOffset + startByte, cursor - startByte)),
          });
          continue;
        } else {
          // System realtime / other: no running status to carry.
          status = 0;
          continue;
        }
      }

      const type = b & 0xf0;
      const channel = b & 0x0f;
      if (type === 0x90 || type === 0x80) {
        if (cursor + 1 >= trackEnd) break;
        const note = view.getUint8(cursor);
        const velocity = view.getUint8(cursor + 1);
        const key = `${channel}:${note}`;
        if (type === 0x90 && velocity > 0) {
          /** @type {NoteHit} */
          const hit = {
            // cursor is already an absolute file offset: the walk starts at
            // payloadOffset and never rebases. Adding payloadOffset again
            // shifts every write into the wrong byte.
            velocityOffset: cursor + 1,
            velocity,
            note,
            channel,
            track: trackIndex,
            tick,
            at: abs,
            durationTicks: 0,
            // Where the two editable bytes of this note-on live. Velocity is a
            // fixed-width write; pitch has to be written twice, here and on the
            // matching note-off, or the pair stops matching and the parser would
            // read the note as hanging.
            pitchOffset: cursor,
            openEventIndex: events.length,
            closeEventIndex: -1,
          };
          notes.push(hit);
          const list = pending.get(key);
          if (list) list.push(hit);
          else pending.set(key, [hit]);
        } else {
          // A note-off is either 0x8n or a 0x9n with velocity 0.
          const list = pending.get(key);
          const hit = list?.shift();
          if (hit) {
            hit.durationTicks = Math.max(0, abs - hit.at);
            hit.releaseAt = abs;
            hit.releaseTick = delta.value;
            hit.releaseOffset = cursor;
            // cursor sits on the pitch byte of the note-off, whether or not the
            // event carried its own status byte.
            hit.releasePitchOffset = cursor;
            hit.closeEventIndex = events.length;
            hit.releaseKind = type === 0x80 ? 'note-off' : 'note-on-zero';
          }
        }
        // Keep the raw event so the track can be re-emitted byte-for-byte.
        events.push({
          kind: type === 0x90 && velocity > 0 ? 'note-on' : 'note-off',
          tick: abs,
          bytes: hasStatus ? [b, note, velocity] : [note, velocity],
          // Where the pitch byte sits inside `bytes`. Under running status the
          // status byte is absent from the file, so it is absent here too.
          pitchIndex: hasStatus ? 1 : 0,
        });
        cursor += 2;
      } else {
        // Program change and channel pressure carry one data byte.
        const width = type === 0xc0 || type === 0xd0 ? 1 : 2;
        events.push({
          kind: 'other',
          tick: abs,
          bytes: hasStatus
            ? Array.from(new Uint8Array(view.buffer, view.byteOffset + cursor - 1, 1 + width))
            : Array.from(new Uint8Array(view.buffer, view.byteOffset + cursor, width)),
        });
        cursor += width;
      }
      if (cursor > trackEnd) break;
    }

    trackList.push({ events, trackIndex, start: trackStart - 8, length: trackLen });
    p = trackEnd;
    trackIndex++;
  }

  return { notes, tracks: trackIndex, division, layout: 'smf', tempoMap, timeSignature, lengthTicks, trackList };
}

/**
 * Convert an absolute tick to seconds using a tempo map.
 *
 * Tempo can change mid-track, so this integrates piecewise rather than using a
 * single rate. Without that, a style with a ritardando would drift audibly
 * against the grid the timeline draws.
 *
 * The tempo map holds microseconds per *quarter note*, so the tick count has to
 * be converted to quarters with the file's division first. Dividing ticks
 * straight by microseconds-per-quarter assumes one tick per quarter and produces
 * a duration off by the division factor - about two minutes reported as
 * fifty-seven hours.
 *
 * @param {TempoPoint[]} tempoMap
 * @param {number} tick
 * @param {number} [division] ticks per quarter note
 * @returns {number} seconds
 */
export function tickToSeconds(tempoMap, tick, division = 480) {
  if (tick <= 0 || division <= 0) return 0;
  const perQuarter = (us) => us / 1e6;
  let seconds = 0;
  let cursorTick = 0;
  let usPerQuarter = tempoMap.length ? tempoMap[0].usPerQuarter : 500000;
  for (const point of tempoMap) {
    if (point.tick >= tick) break;
    if (point.tick > cursorTick) {
      seconds += ((point.tick - cursorTick) / division) * perQuarter(usPerQuarter);
      cursorTick = point.tick;
    }
    usPerQuarter = point.usPerQuarter;
  }
  seconds += ((tick - cursorTick) / division) * perQuarter(usPerQuarter);
  return seconds;
}

/**
 * Ticks in one bar.
 *
 * A time signature's numerator counts beats and its denominator names the note
 * value that gets one beat, so a bar holds `numerator * (4 / denominator)`
 * quarter notes - 4/4 is 4 quarters, 6/8 is 3, 10/16 is 2.5. Dividing by the
 * denominator instead of multiplying would put 6/8 at 12 quarters per bar and
 * produce a grid wildly the wrong size.
 *
 * @param {{numerator: number, denominator: number}} timeSignature
 * @param {number} division ticks per quarter note from the file header
 */
export function ticksPerBar(timeSignature, division = 480) {
  const den = timeSignature.denominator > 0 ? timeSignature.denominator : 4;
  const quarters = (timeSignature.numerator * 4) / den;
  return quarters * division;
}

/**
 * Index notes in a payload that has no SMF header, only a sequence of MTrk
 * chunks.
 *
 * Some Yamaha writers store a second copy of the performance without an MThd -
 * a MER payload can be a bare run of tracks preceded by proprietary header
 * bytes. Refusing those outright would mean editing only one copy of the music
 * and quietly getting silence on half the hardware, so scan for the first MTrk
 * and parse from there.
 *
 * @returns {{notes: NoteHit[], tracks: number, division: number, layout: 'tracks-only', tempoMap: TempoPoint[], timeSignature: TimeSignature, lengthTicks: number, trackList: {events: TrackEvent[], trackIndex: number, start: number, length: number}[], error?: string}}
 */
export function indexTracksOnly(buffer, payloadOffset, payloadSize) {
  const view = new DataView(buffer);
  const end = payloadOffset + payloadSize;
  /** @type {NoteHit[]} */
  const notes = [];
  /** @type {TempoPoint[]} */
  const tempoMap = [{ tick: 0, usPerQuarter: 500000 }];
  /** @type {TimeSignature} */
  let timeSignature = { numerator: 4, denominator: 4 };
  /** @type {Map<string, NoteHit[]>} */
  const pending = new Map();
  /** Raw events per track, so this copy can be edited and written back too. */
  /** @type {{events: TrackEvent[], trackIndex: number, start: number, length: number}[]} */
  const trackList = [];
  let p = payloadOffset;
  let trackIndex = 0;
  let lengthTicks = 0;

  while (p + 8 <= end) {
    if (str(view, p, p + 4) !== 'MTrk') {
      p++;
      continue;
    }
    const trackLen = view.getUint32(p + 4);
    const trackStart = p + 8;
    const trackEnd = trackStart + trackLen;
    if (trackEnd > end) break;

    let cursor = trackStart;
    let status = 0;
    let abs = 0;
    /** @type {TrackEvent[]} */
    const events = [];

    while (cursor < trackEnd) {
      const delta = readVarLen(view, cursor, trackEnd);
      if (!delta) break;
      cursor = delta.next;
      abs += delta.value;
      if (abs > lengthTicks) lengthTicks = abs;

      let b = view.getUint8(cursor);
      let hasStatus = true;
      if (b < 0x80) {
        if (status === 0) break;
        b = status;
        hasStatus = false;
      } else {
        cursor++;
        if (b < 0xf0) {
          status = b;
        } else if (b === 0xff) {
          const startByte = cursor - 1;
          const type = view.getUint8(cursor);
          cursor++;
          const len = readVarLen(view, cursor, trackEnd);
          if (!len) break;
          // The body starts *after* the variable-length length field.
          const body = len.next;
          cursor = body + len.value;
          if (cursor > trackEnd) break;
          if (type === 0x51 && len.value === 3) {
            const usPerQuarter =
              (view.getUint8(body) << 16) | (view.getUint8(body + 1) << 8) | view.getUint8(body + 2);
            if (abs === 0) tempoMap[0] = { tick: 0, usPerQuarter };
            else tempoMap.push({ tick: abs, usPerQuarter });
          } else if (type === 0x58 && len.value >= 2) {
            const denom = view.getUint8(body + 1);
            timeSignature = {
              numerator: view.getUint8(body),
              denominator: denom > 0 && denom < 16 ? 2 ** denom : 4,
            };
          }
          events.push({
            kind: 'meta',
            tick: abs,
            bytes: Array.from(new Uint8Array(view.buffer, view.byteOffset + startByte, cursor - startByte)),
          });
          continue;
        } else if (b === 0xf0 || b === 0xf7) {
          const startByte = cursor - 1;
          const len = readVarLen(view, cursor, trackEnd);
          if (!len) break;
          cursor = len.next + len.value;
          if (cursor > trackEnd) break;
          events.push({
            kind: 'sysex',
            tick: abs,
            bytes: Array.from(new Uint8Array(view.buffer, view.byteOffset + startByte, cursor - startByte)),
          });
          continue;
        } else {
          status = 0;
          continue;
        }
      }

      const type = b & 0xf0;
      const channel = b & 0x0f;
      if (type === 0x90 || type === 0x80) {
        if (cursor + 1 >= trackEnd) break;
        const note = view.getUint8(cursor);
        const velocity = view.getUint8(cursor + 1);
        const key = `${channel}:${note}`;
        if (type === 0x90 && velocity > 0) {
          /** @type {NoteHit} */
          const hit = {
            velocityOffset: cursor + 1,
            velocity,
            note,
            channel,
            track: trackIndex,
            tick: delta.value,
            at: abs,
            durationTicks: 0,
            pitchOffset: cursor,
            openEventIndex: events.length,
            closeEventIndex: -1,
          };
          notes.push(hit);
          const list = pending.get(key);
          if (list) list.push(hit);
          else pending.set(key, [hit]);
        } else {
          const hit = pending.get(key)?.shift();
          if (hit) {
            hit.durationTicks = Math.max(0, abs - hit.at);
            hit.releaseAt = abs;
            hit.releaseTick = delta.value;
            hit.releaseOffset = cursor;
            hit.releasePitchOffset = cursor;
            hit.closeEventIndex = events.length;
            hit.releaseKind = type === 0x80 ? 'note-off' : 'note-on-zero';
          }
        }
        events.push({
          kind: type === 0x90 && velocity > 0 ? 'note-on' : 'note-off',
          tick: abs,
          bytes: hasStatus ? [b, note, velocity] : [note, velocity],
          pitchIndex: hasStatus ? 1 : 0,
        });
        cursor += 2;
      } else {
        const width = type === 0xc0 || type === 0xd0 ? 1 : 2;
        events.push({
          kind: 'other',
          tick: abs,
          bytes: hasStatus
            ? Array.from(new Uint8Array(view.buffer, view.byteOffset + cursor - 1, 1 + width))
            : Array.from(new Uint8Array(view.buffer, view.byteOffset + cursor, width)),
        });
        cursor += width;
      }
      if (cursor > trackEnd) break;
    }

    trackList.push({ events, trackIndex, start: p, length: trackLen });
    p = trackEnd;
    trackIndex++;
  }

  return {
    notes, tracks: trackIndex, division: 0, layout: 'tracks-only',
    tempoMap, timeSignature, lengthTicks, trackList,
  };
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
  return writeVelocities(buffer, targets.map((t) => ({ velocityOffset: t.velocityOffset, velocity: clamped })));
}

/**
 * Patch a different velocity into each note, in one copy of the input.
 *
 * The bulk form above is the common case - one slider, many notes - but dragging a
 * bar in the velocity lane produces a different value per note. Calling the bulk
 * form once per distinct value would copy the whole file each time, so this writes
 * them all in a single pass instead.
 *
 * @param {ArrayBuffer} buffer
 * @param {{velocityOffset: number, velocity: number}[]} targets
 * @returns {ArrayBuffer}
 */
export function applyVelocities(buffer, targets) {
  return writeVelocities(buffer, targets);
}

/** Shared body: one copy of the buffer, then one byte written per target. */
function writeVelocities(buffer, targets) {
  // slice() copies. `new Uint8Array(buffer)` does NOT: constructing a view over
  // an existing ArrayBuffer aliases it, so the write would land in the user's
  // original file - and with it, the bytes we promised not to touch.
  const copy = buffer.slice(0);
  const out = new Uint8Array(copy);
  const view = new DataView(copy);
  for (const t of targets) {
    if (t.velocityOffset < 0 || t.velocityOffset >= out.byteLength) continue;
    const v = Math.max(1, Math.min(127, Math.round(t.velocity)));
    view.setUint8(t.velocityOffset, v);
  }
  return copy;
}
