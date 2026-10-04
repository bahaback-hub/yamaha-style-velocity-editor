/**
 * Round-trip tests for the track serialiser.
 *
 * The contract these enforce: parsing a track and writing it straight back, with
 * nothing changed, must reproduce the original bytes exactly. Length editing is
 * built on this emitter, so if the round trip is not exact then a length edit can
 * produce a file that looks fine and is subtly wrong - a shifted note, a wrong
 * delta, a container that declares more data than it holds. A round trip that is
 * merely "close" is not good enough; it has to be identical.
 *
 * The last test runs the same check against the real exported style, because a
 * synthetic fixture cannot cover the meta, sysex and running-status mix that a
 * genuine file contains. It is skipped when that file is not present, so the suite
 * still runs on a clean checkout.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { writeVarLen, varLenSize, serialiseTrack, replaceTrack } from '../src/track.js';
import { indexNotes } from '../src/smf.js';
import { findMidiPayloads } from '../src/sff.js';

const REAL_STY = 'C:/Users/DSER/AppData/Local/Temp/opencode/fixtures/karadeniz.sty';

function track(events) {
  const len = events.length;
  return Uint8Array.from([
    0x4d, 0x54, 0x72, 0x6b,
    (len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff,
    ...events,
  ]);
}
function mthd(n = 1, division = 480) {
  return Uint8Array.from([
    0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1,
    (n >>> 8) & 0xff, n & 0xff,
    (division >>> 8) & 0xff, division & 0xff,
  ]);
}
function concat(parts) {
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const part of parts) { out.set(part, p); p += part.length; }
  return out;
}
const toBuf = (u8) => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);

// ---- variable-length encoding ----------------------------------------------

test('writeVarLen round-trips the documented examples', () => {
  // Values straight from the Standard MIDI File specification.
  assert.deepEqual(writeVarLen(0), [0x00]);
  assert.deepEqual(writeVarLen(0x40), [0x40]);
  assert.deepEqual(writeVarLen(0x7f), [0x7f]);
  assert.deepEqual(writeVarLen(0x80), [0x81, 0x00]);
  assert.deepEqual(writeVarLen(0x2000), [0xc0, 0x00]);
  assert.deepEqual(writeVarLen(0x3fff), [0xff, 0x7f]);
  assert.deepEqual(writeVarLen(0x100000), [0xc0, 0x80, 0x00]);
  assert.deepEqual(writeVarLen(0x0fffffff), [0xff, 0xff, 0xff, 0x7f]);
});

test('varLenSize agrees with the encoder', () => {
  for (const v of [0, 1, 127, 128, 8191, 8192, 1048576, 268435455]) {
    assert.equal(varLenSize(v), writeVarLen(v).length, `value ${v}`);
  }
});

test('writeVarLen refuses a negative delta rather than emitting garbage', () => {
  assert.throws(() => writeVarLen(-1), RangeError);
});

// ---- round trip on synthetic tracks ----------------------------------------

/** Parse, re-emit, and require identity. Returns the parse for further checks. */
function roundTrip(fileBytes, label) {
  const buffer = toBuf(fileBytes);
  const parsed = indexNotes(buffer, 0, fileBytes.length);
  assert.ok(parsed.tracks > 0, `${label}: expected at least one track`);
  for (const t of parsed.trackList) {
    const emitted = serialiseTrack(t.events);
    const original = new Uint8Array(buffer, t.start + 8, t.length);
    assert.deepEqual([...emitted], [...original], `${label}: track ${t.trackIndex} is not byte-identical`);
  }
  return { buffer, parsed };
}

test('round trip: plain notes', () => {
  roundTrip(concat([mthd(), track([
    0x00, 0x91, 60, 100, 0x60, 0x81, 60, 0,
    0x00, 0x91, 64, 90, 0x60, 0x81, 64, 0,
  ])]), 'plain');
});

test('round trip: meta events with a multi-byte length', () => {
  // The text meta declares a 10-byte body, so exactly ten bytes follow it. A
  // mismatched length here would truncate the track and the failure would look
  // like a serialiser fault rather than a broken fixture.
  const text = [0x68, 0x65, 0x6c, 0x6c, 0x6f, 0x20, 0x77, 0x6f, 0x72, 0x6c]; // "hello worl"
  roundTrip(concat([mthd(), track([
    0x00, 0xff, 0x58, 0x04, 0x04, 0x02, 0x18, 0x08,
    0x00, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20,
    0x00, 0xff, 0x01, 0x0a, ...text,
    0x00, 0x91, 60, 100, 0x60, 0x81, 60, 0,
  ])]), 'meta');
});

test('round trip: a meta length that spans several bytes', () => {
  // A long text meta makes the length itself a two-byte value, which is a
  // separate encoding from the delta-time and just as easy to get wrong.
  const long = new Array(300).fill(0x61);
  roundTrip(concat([mthd(), track([
    0x00, 0xff, 0x01, 0x82, 0x2c, ...long,
    0x00, 0x91, 60, 100, 0x60, 0x81, 60, 0,
  ])]), 'long meta');
});

test('round trip: sysex, including a long one', () => {
  roundTrip(concat([mthd(), track([
    0x00, 0x90, 60, 100,
    0x00, 0xf0, 0x09, 0x43, 0x73, 0x01, 0x50, 0x05, 0x01, 0x2a, 0xf7,
    0x00, 0xf0, 0x7d, ...new Array(124).fill(0x00), 0xf7,
    0x60, 0x80, 60, 0,
  ])]), 'sysex');
});

test('round trip: running status', () => {
  roundTrip(concat([mthd(), track([
    0x00, 0x99, 36, 100, 0x60, 0x89, 36, 0,
    0x00, 38, 90, 0x60, 40, 0,
    0x00, 42, 80, 0x60, 44, 0,
  ])]), 'running status');
});

test('round trip: control change, program change and channel pressure', () => {
  roundTrip(concat([mthd(), track([
    0x00, 0xb1, 0x07, 0x64,          // control change, two data bytes
    0x00, 0xc9, 0x20,                // program change, one data byte
    0x00, 0xd9, 0x40,                // channel pressure, one data byte
    0x00, 0x91, 60, 100, 0x60, 0x81, 60, 0,
  ])]), 'mixed channel messages');
});

test('round trip: multi-byte delta-times at every boundary', () => {
  // 127 is the last single-byte delta and 128 the first two-byte one, so this
  // crosses the boundary where the serialiser is most likely to be wrong.
  // Each pair is a note-on followed by a note-off the given distance later.
  const events = [];
  for (const d of [0, 1, 126, 127, 128, 129, 8191, 8192, 16383, 16384]) {
    events.push(0x00, 0x99, 36, 100);
    events.push(...writeVarLen(d), 0x89, 36, 0);
  }
  roundTrip(concat([mthd(), track(events)]), 'delta boundaries');
});

// ---- editing through the serialiser ----------------------------------------

test('replacing a track with its own body changes nothing', () => {
  const file = concat([mthd(), track([
    0x00, 0x91, 60, 100, 0x60, 0x81, 60, 0,
    0x00, 0x91, 62, 90, 0x60, 0x81, 62, 0,
  ])]);
  const buffer = toBuf(file);
  const parsed = indexNotes(buffer, 0, file.length);
  const t = parsed.trackList[0];
  const body = serialiseTrack(t.events);

  const out = replaceTrack(buffer, {
    payloadOffset: 0, trackStart: t.start, trackLength: t.length, headerSize: 8,
  }, body);

  // Same bytes in, same bytes out.
  assert.deepEqual([...new Uint8Array(out)], [...new Uint8Array(buffer)], 'an unchanged rewrite must be identical');
});

test('lengthening a note re-serialises and the result still parses', () => {
  // One note whose release is the final event, so moving it later cannot step
  // over anything. The release sits 96 ticks in - a one-byte delta - and moves
  // to 200, crossing the 127 boundary so it becomes two bytes and the track
  // length has to be rewritten to match.
  const file = concat([mthd(), track([
    0x00, 0x91, 60, 100,
    0x60, 0x81, 60, 0,
  ])]);
  const buffer = toBuf(file);
  const parsed = indexNotes(buffer, 0, file.length);
  const t = parsed.trackList[0];
  assert.equal(parsed.notes[0].durationTicks, 96, 'the note starts 96 ticks long');
  assert.equal(t.events[t.events.length - 1].kind, 'note-off', 'the release is last');

  const events = t.events.map((e) => ({ ...e, bytes: [...e.bytes] }));
  const offIndex = events.length - 1;
  events[offIndex] = { ...events[offIndex], tick: 200 };

  const body = serialiseTrack(events);
  assert.ok(body.length > t.length, 'the track grew, as expected when a delta widens');

  const out = replaceTrack(buffer, {
    payloadOffset: 0, trackStart: t.start, trackLength: t.length, headerSize: 8,
  }, body);

  // The MTrk length must have been rewritten to match.
  const view = new DataView(out);
  assert.equal(view.getUint32(t.start + 4), body.length, 'MTrk length updated');

  // And the whole thing must still parse, with the note now longer.
  const after = indexNotes(out, 0, out.byteLength);
  assert.equal(after.notes.length, 1, 'the note survived');
  assert.equal(after.notes[0].durationTicks, 200, 'the note is now 200 ticks long');
});

test('a length edit inside an SFF container fixes every enclosing length', () => {
  const inner = concat([mthd(), track([
    0x00, 0x91, 60, 100, 0x60, 0x81, 60, 0,
    0x00, 0x91, 62, 90, 0x60, 0x81, 62, 0,
  ])]);
  const midChunk = (id, payload) => {
    const out = new Uint8Array(8 + payload.length);
    for (let i = 0; i < 4; i++) out[i] = i < id.length ? id.charCodeAt(i) : 0;
    const len = payload.length;
    out[4] = (len >>> 24) & 0xff; out[5] = (len >>> 16) & 0xff;
    out[6] = (len >>> 8) & 0xff; out[7] = len & 0xff;
    out.set(payload, 8);
    return out;
  };
  const med = midChunk('Smed', midChunk('MID', inner));
  const head = Uint8Array.from([0x53, 0x46, 0x46, 0x32, 0, 0, 0, 8, 0x53, 0x53, 0x54, 0x4e]);
  const file = concat([head, med]);
  const buffer = toBuf(file);

  const payloads = findMidiPayloads(buffer).payloads;
  assert.equal(payloads.length, 1);
  const p = payloads[0];
  const parsed = indexNotes(buffer, p.offset, p.size);
  const t = parsed.trackList[0];

  const beforeSmed = new DataView(buffer).getUint32(12 + 4);

  // Grow the track so every length above it has to change. The second note's
  // release is the last event, so pushing it later cannot step over anything;
  // moving the first one would jump over the whole second note.
  const events = t.events.map((e) => ({ ...e, bytes: [...e.bytes] }));
  const offIndex = events.length - 1;
  assert.equal(events[offIndex].kind, 'note-off', 'the last event is a release');
  events[offIndex] = { ...events[offIndex], tick: 4000 };
  const body = serialiseTrack(events);

  const out = replaceTrack(buffer, {
    payloadOffset: p.offset, trackStart: t.start, trackLength: t.length, headerSize: 8,
  }, body);

  const growth = body.length - t.length;
  assert.ok(growth > 0, 'the track grew');
  const view = new DataView(out);
  assert.equal(view.getUint32(t.start + 4), body.length, 'MTrk length updated');
  assert.equal(view.getUint32(12 + 4), beforeSmed + growth, 'Smed length updated too');

  // Every declared length must now match the real data extent.
  const afterPayloads = findMidiPayloads(out).payloads;
  assert.equal(afterPayloads.length, 1, 'the container is still readable');
  const after = indexNotes(out, afterPayloads[0].offset, afterPayloads[0].size);
  assert.equal(after.notes.length, 2);
  assert.equal(after.notes[1].releaseAt, 4000, 'the edit took effect');
  assert.equal(
    after.notes[1].durationTicks, 4000 - after.notes[1].at,
    'and the note is that much longer than before',
  );
});

test('serialiseTrack rejects events that go backwards in time', () => {
  assert.throws(
    () => serialiseTrack([
      { kind: 'note-on', tick: 100, bytes: [0x90, 60, 100] },
      { kind: 'note-on', tick: 50, bytes: [0x90, 62, 100] },
    ]),
    RangeError,
  );
});

// ---- the real file ----------------------------------------------------------

test('round trip on the real exported style is byte-identical', { skip: !existsSync(REAL_STY) }, () => {
  const bytes = readFileSync(REAL_STY);
  const buffer = toBuf(bytes);
  // findMidiPayloads returns a descriptor; the array is on .payloads.
  const info = findMidiPayloads(buffer);
  assert.ok(info.payloads.length > 0);

  for (const p of info.payloads) {
    const parsed = indexNotes(buffer, p.offset, p.size);
    assert.ok(parsed.tracks > 0, `${p.kind} has tracks`);
    for (const t of parsed.trackList) {
      const emitted = serialiseTrack(t.events);
      const original = new Uint8Array(buffer, t.start + 8, t.length);
      assert.deepEqual(
        [...emitted], [...original],
        `${p.kind} track ${t.trackIndex}: ${emitted.length} vs ${original.length} bytes`,
      );
    }
  }
});


