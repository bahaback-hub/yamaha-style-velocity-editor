/**
 * Edit-layer tests.
 *
 * The contract every edit has to keep: the file still parses, the notes survive,
 * and the intended change is the only change. Velocity and pitch are byte writes,
 * so they must not disturb a single other byte; length re-emits the track, so it
 * must at least stay self-consistent and still declare correct container lengths.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

import { indexNotes, indexTracksOnly } from '../src/smf.js';
import { findMidiPayloads } from '../src/sff.js';
import {
  applyEdits,
  clampPitch,
  clampVelocity,
  clampDuration,
  findCollisions,
  patchTrack,
  planEdits,
} from '../src/edits.js';

const REAL_STY = 'C:/Users/DSER/AppData/Local/Temp/opencode/fixtures/karadeniz.sty';

const asU8 = (...v) => Uint8Array.from(v);
const toBuf = (u8) => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
function concat(parts) {
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const part of parts) { out.set(part, p); p += part.length; }
  return out;
}
function mthd(n = 1, division = 480) {
  return asU8(
    0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1,
    (n >>> 8) & 0xff, n & 0xff,
    (division >>> 8) & 0xff, division & 0xff,
  );
}
function track(events) {
  const len = events.length;
  return asU8(
    0x4d, 0x54, 0x72, 0x6b,
    (len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff,
    ...events,
  );
}
/** Two notes, 96 ticks apart, on one track. */
function twoNotes() {
  return toBuf(concat([mthd(), track([
    0x00, 0x91, 60, 100, 0x60, 0x81, 60, 0,
    0x00, 0x91, 62, 90, 0x60, 0x81, 62, 0,
  ])]));
}
const load = (buffer) => indexNotes(buffer, 0, buffer.byteLength);

test('clamps keep a bad number from becoming a bad byte', () => {
  assert.equal(clampVelocity(0), 1, 'a note-off velocity would silence the note');
  assert.equal(clampVelocity(-40), 1);
  assert.equal(clampVelocity(999), 127);
  assert.equal(clampVelocity(63.6), 64, 'rounds rather than truncates');
  assert.equal(clampVelocity(NaN), 1);
  assert.equal(clampPitch(-1), 0);
  assert.equal(clampPitch(128), 127);
  assert.equal(clampPitch(60.2), 60);
  assert.equal(clampDuration(-5), 0);
  assert.equal(clampDuration(Infinity), 0);
});

test('a velocity edit rewrites exactly one byte', () => {
  const buffer = twoNotes();
  const before = new Uint8Array(buffer);
  const parsed = load(buffer);

  const out = applyEdits(buffer, { offset: 0, size: buffer.byteLength }, parsed, [
    { note: parsed.notes[0], velocity: 30 },
  ]);

  const after = new Uint8Array(out);
  const differing = [];
  for (let i = 0; i < before.length; i++) if (before[i] !== after[i]) differing.push(i);
  assert.equal(differing.length, 1, 'only one byte changed');
  assert.equal(differing[0], parsed.notes[0].velocityOffset, 'and it is the velocity byte');

  const reparsed = load(out);
  assert.equal(reparsed.notes[0].velocity, 30);
  assert.equal(reparsed.notes[1].velocity, 90, 'the other note is untouched');
});

test('a pitch edit writes both the note-on and the note-off', () => {
  const buffer = twoNotes();
  const parsed = load(buffer);
  const out = applyEdits(buffer, { offset: 0, size: buffer.byteLength }, parsed, [
    { note: parsed.notes[0], pitch: 72 },
  ]);

  const after = load(out);
  assert.equal(after.notes.length, 2, 'still two notes, not one hanging note');
  assert.equal(after.notes[0].note, 72);
  assert.equal(after.notes[0].durationTicks, 96, 'the pair still matches, so the length is known');
  assert.equal(after.notes[1].note, 62, 'the other note kept its pitch');
});

test('a pitch edit leaves every note byte alone when the pitch does not move', () => {
  const buffer = twoNotes();
  const parsed = load(buffer);
  const out = applyEdits(buffer, { offset: 0, size: buffer.byteLength }, parsed, [
    { note: parsed.notes[0], pitch: 60 },
  ]);
  assert.deepEqual([...new Uint8Array(out)], [...new Uint8Array(buffer)], 'byte-identical');
});

test('velocity, pitch and length can be edited together', () => {
  const buffer = twoNotes();
  const parsed = load(buffer);
  const out = applyEdits(buffer, { offset: 0, size: buffer.byteLength }, parsed, [
    { note: parsed.notes[0], velocity: 20, pitch: 55, durationTicks: 480 },
  ]);

  const after = load(out);
  const edited = after.notes.find((n) => n.note === 55);
  assert.ok(edited, 'the note moved to its new pitch');
  assert.equal(edited.velocity, 20);
  assert.equal(edited.durationTicks, 480);
  assert.equal(after.notes.length, 2, 'and nothing was lost');
});

test('a length edit that lands past the next note re-sorts the track', () => {
  // Note 1 opens at 0 and note 2 at 96. Stretching note 1 to 480 puts its release
  // after note 2's note-on, which MIDI allows but only if the event list is
  // re-ordered by tick. Re-emitting without sorting would produce a track whose
  // deltas go backwards.
  const buffer = twoNotes();
  const parsed = load(buffer);
  assert.ok(parsed.notes[1].at < 480, 'the second note really does start earlier');

  const out = applyEdits(buffer, { offset: 0, size: buffer.byteLength }, parsed, [
    { note: parsed.notes[0], durationTicks: 480 },
  ]);

  const after = load(out);
  const long = after.notes.find((n) => n.at === 0);
  assert.equal(long.durationTicks, 480, 'the note really is 480 ticks long');
  // Each note-off must still follow its own note-on.
  for (const n of after.notes) {
    assert.ok(n.durationTicks > 0, `note at ${n.at} kept a length`);
    assert.equal(n.releaseAt, n.at + n.durationTicks);
  }
});

test('length edits to several tracks all survive the shifting offsets', () => {
  const buffer = toBuf(concat([
    mthd(2),
    track([0x00, 0x91, 60, 100, 0x60, 0x81, 60, 0]),
    track([0x00, 0x92, 67, 100, 0x60, 0x82, 67, 0]),
  ]));
  const parsed = load(buffer);
  assert.equal(parsed.tracks, 2);

  const out = applyEdits(buffer, { offset: 0, size: buffer.byteLength }, parsed, [
    { note: parsed.notes[0], durationTicks: 5000 },
    { note: parsed.notes[1], durationTicks: 9000 },
  ]);

  const after = load(out);
  assert.equal(after.tracks, 2);
  assert.equal(after.notes.length, 2);
  assert.equal(after.notes[0].durationTicks, 5000, 'the first track kept its edit');
  assert.equal(after.notes[1].durationTicks, 9000, 'the second track kept its edit');
});

test('a hanging note gains a release when given a length', () => {
  const buffer = toBuf(concat([mthd(), track([0x00, 0x91, 60, 100])]));
  const parsed = load(buffer);
  assert.equal(parsed.notes[0].durationTicks, 0, 'it starts out hanging');
  assert.equal(parsed.notes[0].closeEventIndex, -1, 'with no note-off to patch');

  const out = applyEdits(buffer, { offset: 0, size: buffer.byteLength }, parsed, [
    { note: parsed.notes[0], durationTicks: 240 },
  ]);

  const after = load(out);
  assert.equal(after.notes[0].durationTicks, 240, 'the release was created');
  assert.equal(after.notes[0].releaseKind, 'note-off');
});

test('a hanging note given a length of zero is left hanging', () => {
  const buffer = toBuf(concat([mthd(), track([0x00, 0x91, 60, 100])]));
  const parsed = load(buffer);
  const out = applyEdits(buffer, { offset: 0, size: buffer.byteLength }, parsed, [
    { note: parsed.notes[0], durationTicks: 0 },
  ]);
  assert.deepEqual([...new Uint8Array(out)], [...new Uint8Array(buffer)], 'nothing to do');
});

// ---- adding and removing -----------------------------------------------------
// A player builds a part by adding to it and taking from it, not only by retuning
// what is already there. Both change the file's length, so both have to keep the
// rest of it intact.

test('a removed note takes both halves of its pair out of the file', () => {
  const buffer = twoNotes();
  const parsed = load(buffer);
  assert.equal(parsed.notes.length, 2);

  const out = applyEdits(buffer, { offset: 0, size: buffer.byteLength }, parsed, [
    { note: parsed.notes[0], remove: true },
  ]);

  const after = load(out);
  assert.equal(after.notes.length, 1, 'one note is left');
  // The survivor must be the second note, with its own values intact - taking the
  // wrong release would silence the wrong key.
  assert.equal(after.notes[0].note, 62, 'the note that was kept is the right one');
  assert.equal(after.notes[0].velocity, 90, 'and it kept its velocity');
  assert.equal(after.notes[0].durationTicks, 96, 'and its length');
});

test('removing every note leaves a track that still parses', () => {
  const buffer = twoNotes();
  const parsed = load(buffer);
  const out = applyEdits(buffer, { offset: 0, size: buffer.byteLength }, parsed, [
    { note: parsed.notes[0], remove: true },
    { note: parsed.notes[1], remove: true },
  ]);
  const after = load(out);
  assert.equal(after.notes.length, 0, 'nothing is left to sound');
  assert.ok(!after.error, `and it is still a readable track: ${after.error}`);
});

test('removing a hanging note drops only its note-on', () => {
  const buffer = toBuf(concat([mthd(), track([0x00, 0x91, 60, 100])]));
  const parsed = load(buffer);
  assert.equal(parsed.notes[0].closeEventIndex, -1, 'it has no release to remove');

  const out = applyEdits(buffer, { offset: 0, size: buffer.byteLength }, parsed, [
    { note: parsed.notes[0], remove: true },
  ]);
  assert.equal(load(out).notes.length, 0);
});

test('an added note arrives with its pitch, velocity and length', () => {
  const buffer = twoNotes();
  const parsed = load(buffer);

  const out = applyEdits(buffer, { offset: 0, size: buffer.byteLength }, parsed, [
    { add: { track: 0, at: 480, pitch: 64, velocity: 88, durationTicks: 240 } },
  ]);

  const after = load(out);
  assert.equal(after.notes.length, 3, 'the new note is there');
  const added = after.notes.find((n) => n.note === 64);
  assert.ok(added, 'on the pitch it was asked for');
  assert.equal(added.at, 480, 'at the tick it was asked for');
  assert.equal(added.velocity, 88);
  assert.equal(added.durationTicks, 240, 'and it stops when it should');
  // The two originals are untouched, and still ordered before it.
  assert.deepEqual(
    after.notes.filter((n) => n.note !== 64).map((n) => [n.note, n.velocity, n.durationTicks]),
    [[60, 100, 96], [62, 90, 96]],
    'the notes already in the file are unchanged',
  );
});

test('an added note is not left hanging, even at zero length', () => {
  const buffer = twoNotes();
  const parsed = load(buffer);
  // A note-on with no release is a hanging note: it keeps sounding, and the parser
  // pairs a later release with the oldest open note on that key.
  const out = applyEdits(buffer, { offset: 0, size: buffer.byteLength }, parsed, [
    { add: { track: 0, at: 480, pitch: 64, velocity: 90, durationTicks: 0 } },
  ]);
  const added = load(out).notes.find((n) => n.note === 64);
  assert.ok(added, 'the note exists');
  assert.equal(added.durationTicks, 0, 'and has no length');
  assert.notEqual(added.closeEventIndex, -1, 'but still got a release to stop it');
});

test('an added note lands at the right tick when other events share it', () => {
  // The existing note-off is at tick 96; adding at 96 puts a new note-on beside
  // it, and the two must not be reordered into each other.
  const buffer = twoNotes();
  const parsed = load(buffer);
  const out = applyEdits(buffer, { offset: 0, size: buffer.byteLength }, parsed, [
    { add: { track: 0, at: 96, pitch: 67, velocity: 70, durationTicks: 48 } },
  ]);
  const added = load(out).notes.find((n) => n.note === 67);
  assert.ok(added, 'the note was added');
  assert.equal(added.at, 96);
  assert.equal(added.durationTicks, 48);
  assert.equal(load(out).notes.length, 3, 'and nothing was corrupted');
});

test('adding and removing in one pass keeps both sides consistent', () => {
  const buffer = twoNotes();
  const parsed = load(buffer);
  const out = applyEdits(buffer, { offset: 0, size: buffer.byteLength }, parsed, [
    { note: parsed.notes[0], remove: true },
    { add: { track: 0, at: 480, pitch: 65, velocity: 95, durationTicks: 120 } },
  ]);
  const after = load(out);
  assert.equal(after.notes.length, 2, 'one out, one in');
  assert.deepEqual(after.notes.map((n) => n.note).sort(), [62, 65]);
});

test('an added note is clamped rather than trusted', () => {
  const buffer = twoNotes();
  const parsed = load(buffer);
  const out = applyEdits(buffer, { offset: 0, size: buffer.byteLength }, parsed, [
    { add: { track: 0, at: -50, pitch: 999, velocity: 5000, durationTicks: 240 } },
  ]);
  const after = load(out);
  // Found by pitch, not by position: the clamp moves it to tick 0, where it sits
  // beside a note that was already there, so it is not last in the list.
  const added = after.notes.find((n) => n.note === 127);
  assert.ok(added, `the note still exists: ${JSON.stringify(after.notes.map((n) => [n.at, n.note]))}`);
  assert.equal(added.at, 0, 'a negative tick is pulled to zero');
  assert.equal(added.velocity, 127, 'the velocity stops at the top of MIDI');
  assert.equal(added.durationTicks, 240, 'and the length is still what was asked for');
});

test('a removed note is not reported as a collision', () => {
  const buffer = twoNotes();
  const parsed = load(buffer);
  // Both notes are the same pitch here, so shrinking one into the other would
  // otherwise be reported - but a note that is going away cannot collide.
  const tight = toBuf(concat([mthd(), track([
    0x00, 0x91, 60, 100, 0x60, 0x81, 60, 0,
    0x00, 0x91, 60, 90, 0x60, 0x81, 60, 0,
  ])]));
  const parsedTight = load(tight);
  const clashes = findCollisions(parsedTight, [
    { note: parsedTight.notes[0], remove: true },
    { note: parsedTight.notes[1], durationTicks: 500 },
  ]);
  assert.equal(clashes.length, 0, `no clash from a note that is leaving: ${JSON.stringify(clashes)}`);
  assert.ok(parsed, 'the two-notes buffer was still built');
});

test('an edit that both removes and retunes only removes', () => {
  const buffer = twoNotes();
  const parsed = load(buffer);
  const out = applyEdits(buffer, { offset: 0, size: buffer.byteLength }, parsed, [
    { note: parsed.notes[0], remove: true, velocity: 127, pitch: 70 },
  ]);
  const after = load(out);
  assert.equal(after.notes.length, 1);
  assert.equal(after.notes[0].note, 62, 'no note was transposed into existence');
});

test('no edits returns the same buffer rather than a copy', () => {
  const buffer = twoNotes();
  const parsed = load(buffer);
  assert.equal(applyEdits(buffer, { offset: 0, size: buffer.byteLength }, parsed, []), buffer);
  assert.equal(applyEdits(buffer, { offset: 0, size: buffer.byteLength }, parsed, [{}]), buffer);
});

test('the input buffer is never modified', () => {
  const buffer = twoNotes();
  const snapshot = [...new Uint8Array(buffer)];
  const parsed = load(buffer);
  applyEdits(buffer, { offset: 0, size: buffer.byteLength }, parsed, [
    { note: parsed.notes[0], velocity: 5, pitch: 30, durationTicks: 2000 },
  ]);
  assert.deepEqual([...new Uint8Array(buffer)], snapshot);
});

test('a length edit reaches the headerless MER copy too', () => {
  // Newer arrangers read MER when it is present, so an edit that only reaches MID
  // leaves half the hardware playing the untouched performance.
  const chunk = (id, payload) => {
    const out = new Uint8Array(8 + payload.length);
    for (let i = 0; i < 4; i++) out[i] = i < id.length ? id.charCodeAt(i) : 0;
    const len = payload.length;
    out[4] = (len >>> 24) & 0xff; out[5] = (len >>> 16) & 0xff;
    out[6] = (len >>> 8) & 0xff; out[7] = len & 0xff;
    out.set(payload, 8);
    return out;
  };
  const events = [0x00, 0x91, 60, 100, 0x60, 0x81, 60, 0];
  const smf = concat([mthd(), track(events)]);
  // MER stored without an MThd, behind a few proprietary bytes.
  const merBare = concat([asU8(0, 0, 0, 0, 1, 0x20), track(events)]);
  const file = concat([
    asU8(0x53, 0x46, 0x46, 0x32, 0, 0, 0, 8, 0x53, 0x53, 0x54, 0x4e),
    chunk('Smed', concat([chunk('MID', smf), chunk('MER', merBare)])),
  ]);
  const buffer = toBuf(file);

  const payloads = findMidiPayloads(buffer).payloads;
  assert.equal(payloads.length, 2);

  const mer = payloads.find((p) => p.kind === 'MER');
  const parsed = indexNotes(buffer, mer.offset, mer.size);
  assert.ok(parsed.error, 'the SMF parser refuses it, as expected');

  const fallback = indexTracksOnly(buffer, mer.offset, mer.size);
  assert.equal(fallback.layout, 'tracks-only');
  assert.equal(fallback.notes.length, 1);
  assert.equal(fallback.trackList.length, 1, 'the raw events came back too');
  assert.ok(fallback.trackList[0].events.length > 0);

  const out = applyEdits(buffer, mer, fallback, [
    { note: fallback.notes[0], durationTicks: 700 },
  ]);

  const after = findMidiPayloads(out).payloads;
  assert.equal(after.length, 2, 'both payloads are still readable');
  const merAfter = after.find((p) => p.kind === 'MER');
  const reparsed = indexTracksOnly(out, merAfter.offset, merAfter.size);
  assert.equal(reparsed.notes[0].durationTicks, 700, 'the edit reached the MER copy');
});

test('an edit inside an SFF container keeps every declared length correct', () => {
  const inner = concat([mthd(), track([0x00, 0x91, 60, 100, 0x60, 0x81, 60, 0])]);
  const chunk = (id, payload) => {
    const out = new Uint8Array(8 + payload.length);
    for (let i = 0; i < 4; i++) out[i] = i < id.length ? id.charCodeAt(i) : 0;
    const len = payload.length;
    out[4] = (len >>> 24) & 0xff; out[5] = (len >>> 16) & 0xff;
    out[6] = (len >>> 8) & 0xff; out[7] = len & 0xff;
    out.set(payload, 8);
    return out;
  };
  const med = chunk('Smed', chunk('MID', inner));
  const file = concat([asU8(0x53, 0x46, 0x46, 0x32, 0, 0, 0, 8, 0x53, 0x53, 0x54, 0x4e), med]);
  const buffer = toBuf(file);

  const payload = findMidiPayloads(buffer).payloads[0];
  const parsed = indexNotes(buffer, payload.offset, payload.size);
  const out = applyEdits(buffer, payload, parsed, [
    { note: parsed.notes[0], durationTicks: 4000 },
  ]);

  const view = new DataView(out);
  const smedBefore = new DataView(buffer).getUint32(16);
  const midBefore = new DataView(buffer).getUint32(24);
  const growth = out.byteLength - buffer.byteLength;
  assert.equal(view.getUint32(16), smedBefore + growth, 'Smed grew by the same amount');
  assert.equal(view.getUint32(24), midBefore + growth, 'so did MID');

  const after = findMidiPayloads(out).payloads;
  assert.equal(after.length, 1, 'the container is still readable');
  const reparsed = indexNotes(out, after[0].offset, after[0].size);
  assert.equal(reparsed.notes[0].durationTicks, 4000);
});

test('planEdits reports what it intends to touch', () => {
  const buffer = twoNotes();
  const parsed = load(buffer);
  const plan = planEdits(parsed, [
    { note: parsed.notes[0], velocity: 10, pitch: 61, durationTicks: 300 },
  ]);
  const patches = plan.get(0);
  assert.ok(patches.length >= 2, 'the note-on and the note-off are both patched');

  const on = patches.find((p) => p.eventIndex === parsed.notes[0].openEventIndex);
  assert.equal(on.velocity, 10);
  assert.equal(on.pitch, 61);

  const off = patches.find((p) => p.eventIndex === parsed.notes[0].closeEventIndex);
  assert.equal(off.pitch, 61, 'the release is retuned to match');
  assert.equal(off.tick, parsed.notes[0].at + 300, 'and moved to the new release tick');
});

test('planEdits merges repeated edits to the same note', () => {
  const buffer = twoNotes();
  const parsed = load(buffer);
  const plan = planEdits(parsed, [
    { note: parsed.notes[0], velocity: 10 },
    { note: parsed.notes[0], velocity: 20 },
  ]);
  const on = plan.get(0).find((p) => p.eventIndex === parsed.notes[0].openEventIndex);
  assert.equal(on.velocity, 20, 'the last edit wins');
});

test('collisions are reported before a transpose that would break pairing', () => {
  // Both notes are held at once on different keys: the lower opens at 0 and is
  // not released until 528, while the upper opens at 48.
  const buffer = toBuf(concat([mthd(), track([
    0x00, 0x91, 60, 100,
    0x30, 0x91, 62, 90,           // opens 48 ticks in
    0x83, 0x60, 0x81, 60, 0,      // released at 528, a two-byte delta
    0x83, 0x60, 0x81, 62, 0,      // released at 1008
  ])]));
  const parsed = load(buffer);
  assert.equal(parsed.notes[0].durationTicks, 528);
  assert.equal(parsed.notes[1].at, 48);
  assert.equal(findCollisions(parsed, []).length, 0, 'the file is clean to begin with');

  // Transposing the second note onto the first one's pitch while it still sounds.
  const clashes = findCollisions(parsed, [{ note: parsed.notes[1], pitch: 60 }]);
  assert.equal(clashes.length, 1, 'that would put two open notes on one key');

  // Releasing the held note first leaves nothing to collide with.
  const clear = findCollisions(parsed, [
    { note: parsed.notes[1], pitch: 60 },
    { note: parsed.notes[0], durationTicks: 0 },
  ]);
  assert.equal(clear.length, 0);
});

test('events sharing a tick keep their original order', () => {
  // A chord: three note-ons at tick 0 written under running status, then the
  // releases. Re-sorting by tick must not reshuffle the openings, or the pairings
  // swap and the durations come out attached to the wrong notes.
  const buffer = toBuf(concat([mthd(), track([
    0x00, 0x91, 60, 100,
    0x00, 64, 100,
    0x00, 67, 100,
    0x60, 0x81, 60, 0,
    0x00, 64, 0,
    0x00, 67, 0,
  ])]));
  const parsed = load(buffer);
  assert.deepEqual(parsed.notes.map((n) => n.note), [60, 64, 67]);
  assert.deepEqual(parsed.notes.map((n) => n.at), [0, 0, 0], 'all three start together');
  assert.deepEqual(parsed.notes.map((n) => n.durationTicks), [96, 96, 96]);

  // Stretch the lowest note so its release has to travel past the other two.
  const out = applyEdits(buffer, { offset: 0, size: buffer.byteLength }, parsed, [
    { note: parsed.notes[0], durationTicks: 1000 },
  ]);
  const after = load(out);
  assert.equal(after.notes.length, 3, 'no note was lost or duplicated');
  assert.deepEqual(after.notes.map((n) => n.note), [60, 64, 67], 'same pitches, same order');
  assert.deepEqual(after.notes.map((n) => n.durationTicks), [1000, 96, 96],
    'each release stayed with its own note-on');
});

test('patchTrack is a pure function of its inputs', () => {
  const buffer = twoNotes();
  const parsed = load(buffer);
  const events = parsed.trackList[0].events;
  const snapshot = JSON.stringify(events);
  patchTrack(events, [{ eventIndex: 0, velocity: 3 }]);
  assert.equal(JSON.stringify(events), snapshot, 'the event list is not mutated');
});

test('a real-world edit round-trips through the whole path', { skip: !existsSync(REAL_STY) }, () => {
  const bytes = readFileSync(REAL_STY);
  const buffer = toBuf(bytes);
  const payload = findMidiPayloads(buffer).payloads[0];
  const parsed = indexNotes(buffer, payload.offset, payload.size);
  assert.ok(parsed.notes.length > 1000, 'the fixture is a real style');

  // Something an editor would plausibly do: lift one channel and double a length.
  const targets = parsed.notes.filter((n) => n.channel === 1).slice(0, 40);
  const doubledLength = targets[0].durationTicks * 2;
  const out = applyEdits(buffer, payload, parsed, [
    ...targets.map((note) => ({ note, velocity: clampVelocity(note.velocity + 12) })),
    { note: targets[0], durationTicks: doubledLength },
  ]);

  assert.ok(out.byteLength >= buffer.byteLength, 'the file did not shrink');

  const afterPayload = findMidiPayloads(out).payloads;
  assert.equal(afterPayload.length, 1, 'the file is still a readable style');
  const after = indexNotes(out, afterPayload[0].offset, afterPayload[0].size);

  assert.equal(after.notes.length, parsed.notes.length, 'no notes were lost or invented');
  assert.equal(
    after.lengthTicks,
    Math.max(parsed.lengthTicks, targets[0].at + doubledLength),
    'the timeline only grew if the stretched note reached past the old end',
  );

  // A tick alone does not identify a note - a chord puts several on the same one -
  // so match on the whole position.
  const keyOf = (n) => `${n.at}:${n.channel}:${n.note}`;
  const wanted = new Map(targets.map((n) => [keyOf(n), clampVelocity(n.velocity + 12)]));
  let checked = 0;
  for (const n of after.notes) {
    const want = wanted.get(keyOf(n));
    if (want === undefined) continue;
    assert.equal(n.velocity, want, `velocity at tick ${n.at}`);
    checked++;
  }
  assert.equal(checked, targets.length, 'every targeted note was checked');
  const doubled = after.notes.find((n) => n.at === targets[0].at);
  assert.equal(doubled.durationTicks, doubledLength, 'the length edit took');

  // The declared payload size must still describe the real remaining bytes.
  const view = new DataView(out);
  assert.equal(view.getUint32(0), 0x4d546864, 'still opens with MThd');
  assert.equal(
    afterPayload[0].size,
    out.byteLength - afterPayload[0].offset,
    'the payload declares every byte that follows it',
  );
});
