/**
 * Turning editor gestures into bytes.
 *
 * A piano roll gesture arrives as "this note, this velocity / pitch / length".
 * Getting that into the file takes one of two routes, and which one matters:
 *
 *   - Velocity and pitch are fixed-width. A velocity is a single byte, and a
 *     pitch is a single byte that has to be written twice - once on the note-on
 *     and once on its note-off, or the pair stops matching and the next reader
 *     treats the note as hanging. Nothing moves, so no length changes.
 *
 *   *   - Length is not fixed-width. A note's length is the delta-time before its
 *     note-off, and delta-times are variable-length, so lengthening a note can
 *     turn a one-byte delta into two and shift every byte after it. On top of
 *     that, MIDI events are ordered by tick, and a note-off may legally sit
 *     after a later note-on - but only if the list is re-sorted. Moving a
 *     release past its neighbours without re-sorting produces an invalid track.
 *
 *   - Adding and removing are structural in the same way. A new note is two
 *     events with no bytes to patch in place, and a removed note has to take both
 *     halves of its pair out - leaving the release behind would silence some other
 *     note on that key, because a release is matched to the oldest open note rather
 *     than to a specific one.
 *
 * So length edits re-emit the whole track, and the re-emitter re-sorts first.
 * Because that shifts byte offsets, this module never writes an absolute offset
 * after a length edit: it plans every change as an event patch, emits the track
 * once, and writes the result in a single splice. Offsets recorded by the parser
 * stay valid for their own buffer, which is why callers must re-parse after
 * editing rather than keep editing against stale numbers.
 */

import { replaceTrack, serialiseTrack } from './track.js';

/** A note-off needs a real velocity to be silent; 0 on a 0x9n also means off. */
export const MIN_VELOCITY = 1;
export const MAX_VELOCITY = 127;
export const MIN_PITCH = 0;
export const MAX_PITCH = 127;

/** Clamp to the range MIDI actually stores, so a stray slider cannot corrupt a byte. */
export function clampVelocity(value) {
  if (!Number.isFinite(value)) return MIN_VELOCITY;
  return Math.max(MIN_VELOCITY, Math.min(MAX_VELOCITY, Math.round(value)));
}

export function clampPitch(value) {
  if (!Number.isFinite(value)) return MIN_PITCH;
  return Math.max(MIN_PITCH, Math.min(MAX_PITCH, Math.round(value)));
}

/** Clamp a length to something a tick can hold, and never negative. */
export function clampDuration(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.round(value));
}

/**
 * Turn a set of note edits into per-track event patches.
 *
 * Each edit names a note from `indexNotes` and may carry any of `velocity`,
 * `pitch` or `durationTicks`. Pitch expands to two events, because the note-off
 * carries the pitch too. A length edit targets the note-off's tick, not its
 * delta, so the value is absolute and independent of what came before it.
 *
 * An edit may instead carry `remove`, which drops the note entirely, or `add`,
 * which describes a note that does not exist yet - the two together are what a
 * player does with a part, since a part is added to and taken from rather than
 * only retuned.
 *
 * @param {{trackList: {events: any[]}[], notes: any[]}} parsed
 * @param {{note: any, velocity?: number, pitch?: number, durationTicks?: number,
 *   remove?: boolean,
 *   add?: {track: number, at: number, pitch: number, velocity: number, durationTicks: number}}}[]} edits
 * @returns {Map<number, {eventIndex: number, pitch?: number, velocity?: number, tick?: number,
 *   remove?: boolean, insert?: any}[]>} patches keyed by track index
 */
export function planEdits(parsed, edits) {
  /** @type {Map<number, Map<number, any>>} */
  const byTrack = new Map();
  /** @type {{note: any, insert?: any}[]} */
  const insertions = [];

  const patch = (trackIndex, eventIndex, change) => {
    let perTrack = byTrack.get(trackIndex);
    if (!perTrack) {
      perTrack = new Map();
      byTrack.set(trackIndex, perTrack);
    }
    const existing = perTrack.get(eventIndex);
    if (existing) Object.assign(existing, change);
    else perTrack.set(eventIndex, { eventIndex, ...change });
  };

  for (const edit of edits) {
    // A note that is not there yet becomes a pair of events: the note-on, and the
    // release. Both are needed - a note-on with no release is a hanging note, and
    // the parser pairs a release with the oldest open note of the same pitch, so a
    // missing one leaves the next note on that key sounding twice.
    if (edit?.add) {
      const a = edit.add;
      const channel = a.channel & 0x0f;
      const pitch = clampPitch(a.pitch);
      insertions.push({
        note: { track: a.track },
        event: {
          kind: 'note-on',
          tick: Math.max(0, Math.round(a.at)),
          bytes: [0x90 | channel, pitch, clampVelocity(a.velocity)],
          pitchIndex: 1,
        },
      });
      // The release is written even at zero length, and lands on the same tick.
      // A note-on with no release is a hanging note: it never stops sounding, and
      // the parser pairs a later release with the oldest open note on that key, so
      // it goes on silencing notes the player never touched.
      insertions.push({
        note: { track: a.track },
        event: {
          kind: 'note-off',
          tick: Math.max(0, Math.round(a.at)) + clampDuration(a.durationTicks),
          bytes: [0x80 | channel, pitch, 0],
          pitchIndex: 1,
        },
      });
      continue;
    }

    const note = edit?.note;
    if (!note) continue;
    const trackIndex = note.track;

    // Removing a note means dropping both halves of the pair. Taking only the
    // note-on leaves a release that will silence some other note on that key - the
    // parser matches a release to the oldest open note, not to a specific one.
    if (edit.remove) {
      patch(trackIndex, note.openEventIndex, { remove: true });
      if (note.closeEventIndex >= 0) patch(trackIndex, note.closeEventIndex, { remove: true });
      continue;
    }

    if (edit.velocity !== undefined) {
      patch(trackIndex, note.openEventIndex, { velocity: clampVelocity(edit.velocity) });
    }

    if (edit.pitch !== undefined) {
      const pitch = clampPitch(edit.pitch);
      patch(trackIndex, note.openEventIndex, { pitch });
      // The note-off names the same pitch. Leaving it behind would break the pair.
      if (note.closeEventIndex >= 0) patch(trackIndex, note.closeEventIndex, { pitch });
    }

    if (edit.durationTicks !== undefined) {
      const duration = clampDuration(edit.durationTicks);
      if (note.closeEventIndex >= 0) {
        patch(trackIndex, note.closeEventIndex, { tick: note.at + duration });
      } else if (duration > 0) {
        // The note never had a release, so giving it a length means adding one.
        insertions.push({
          note,
          event: {
            kind: 'note-off',
            tick: note.at + duration,
            bytes: [0x80 | (note.channel & 0x0f), clampPitch(note.note), 0],
            pitchIndex: 1,
          },
        });
      }
    }
  }

  // Patches keyed by track, plus any events that had to be created.
  /** @type {Map<number, any[]>} */
  const out = new Map();
  for (const [trackIndex, perTrack] of byTrack) {
    out.set(trackIndex, [...perTrack.values()]);
  }
  for (const { note, event } of insertions) {
    const list = out.get(note.track) ?? [];
    list.push({ eventIndex: -1, tick: event.tick, insert: event });
    out.set(note.track, list);
  }
  return out;
}

/**
 * Re-emit one track with its patches applied.
 *
 * Events are re-sorted by tick before emitting, because a length edit can put a
 * release after an event that used to follow it. The sort is stable, so events
 * that share a tick keep their original order - several notes struck together
 * must stay in the order they were written, or the note-on/note-off pairing
 * changes and durations silently swap.
 *
 * A removed event drops out entirely rather than being patched, so it is filtered
 * before the survivors are stamped.
 *
 * @param {any[]} events
 * @param {{eventIndex: number, pitch?: number, velocity?: number, tick?: number,
 *   remove?: boolean, insert?: any}[]} patches
 * @returns {Uint8Array} the new MTrk body
 */
export function patchTrack(events, patches) {
  const byIndex = new Map();
  const inserted = [];
  const removed = new Set();
  for (const p of patches) {
    if (p.eventIndex < 0) {
      if (p.insert) inserted.push({ event: p.insert, order: events.length + inserted.length });
      continue;
    }
    byIndex.set(p.eventIndex, p);
    if (p.remove) removed.add(p.eventIndex);
  }

  const stamped = [];
  events.forEach((event, i) => {
    if (removed.has(i)) return;
    const p = byIndex.get(i);
    if (!p) { stamped.push({ event, order: i }); return; }
    const bytes = event.bytes.slice();
    // pitchIndex is only set on note events; anything else has no editable bytes.
    if (event.pitchIndex !== undefined) {
      if (p.pitch !== undefined) bytes[event.pitchIndex] = p.pitch;
      if (p.velocity !== undefined) bytes[event.pitchIndex + 1] = p.velocity;
    }
    stamped.push({
      event: { ...event, bytes, tick: p.tick ?? event.tick },
      order: i,
    });
  });

  for (const extra of inserted) stamped.push(extra);

  stamped.sort((a, b) => a.event.tick - b.event.tick || a.order - b.order);
  return serialiseTrack(stamped.map((s) => s.event));
}

/**
 * Apply note edits to a file and return a new buffer.
 *
 * Tracks are rewritten from the last to the first. Each rewrite changes the file's
 * length, which would move every track after it; going backwards means the offsets
 * recorded by the original parse are still correct for each track as it is
 * reached.
 *
 * @param {ArrayBuffer} buffer the whole file
 * @param {{offset: number, size: number}} payload the MIDI payload inside it
 * @param {{trackList: {events: any[]}[], notes: any[]}} parsed from `buffer`
 * @param {{note: any, velocity?: number, pitch?: number, durationTicks?: number,
 *   remove?: boolean, add?: {track: number, at: number, pitch: number, velocity: number, durationTicks: number}}[]} edits
 * @returns {ArrayBuffer} a new buffer; the input is not modified
 */
export function applyEdits(buffer, payload, parsed, edits) {
  const planned = planEdits(parsed, edits);
  if (planned.size === 0) return buffer;

  const order = [...planned.keys()].sort((a, b) => b - a);
  let out = buffer;
  for (const trackIndex of order) {
    const track = parsed.trackList[trackIndex];
    if (!track) continue;
    const body = patchTrack(track.events, planned.get(trackIndex));
    out = replaceTrack(out, {
      payloadOffset: payload.offset,
      trackStart: track.start,
      trackLength: track.length,
      headerSize: 8,
    }, body);
  }
  return out;
}

/**
 * Report notes that would collide once the edits are applied.
 *
 * The parser pairs a release with the oldest open note of the same channel and
 * pitch, so two overlapping notes on one key do not each get their own length -
 * they silently swap. Transposing a note onto a neighbour's pitch is the easy way
 * to cause it, and the result still parses, so it would otherwise pass unnoticed.
 *
 * @param {{trackList: {events: any[]}[], notes: any[]}} parsed
 * @param {{note: any, velocity?: number, pitch?: number, durationTicks?: number}[]} edits
 * @returns {{note: any, other: any}[]} pairs of notes that would overlap on a key
 */
export function findCollisions(parsed, edits) {
  const changes = new Map();
  for (const edit of edits) {
    if (!edit?.note) continue;
    const change = {};
    if (edit.pitch !== undefined) change.pitch = clampPitch(edit.pitch);
    if (edit.velocity !== undefined) change.velocity = clampVelocity(edit.velocity);
    if (edit.durationTicks !== undefined) change.duration = clampDuration(edit.durationTicks);
    changes.set(edit.note, change);
  }

  // A removed note cannot collide with anything, and an added one is not in the
  // parse yet, so both are left out of the overlap walk.
  for (const edit of edits) {
    if (!edit?.note) continue;
    if (edit.remove) changes.set(edit.note, { gone: true });
  }

  const pitchOf = (n) => changes.get(n)?.pitch ?? n.note;
  const endOf = (n) => n.at + (changes.get(n)?.duration ?? n.durationTicks);
  const open = new Map();
  const clashes = [];

  const sameTrack = parsed.notes.filter((n) => n.channel !== undefined && !changes.get(n)?.gone);
  for (const note of sameTrack) {
    const key = `${note.track}:${note.channel}:${pitchOf(note)}`;
    const list = open.get(key) ?? [];
    for (const other of list) {
      // A zero-length note ends the instant it starts and cannot really overlap.
      const overlap = Math.min(endOf(note), endOf(other)) - Math.max(note.at, other.at);
      if (overlap > 0) clashes.push({ note, other });
    }
    list.push(note);
    open.set(key, list);
  }
  return clashes;
}
