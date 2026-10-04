/**
 * Parser tests, run on a synthetic SFF built here rather than on a real style.
 *
 * A synthetic fixture is the point: it asserts exact byte offsets, so a
 * regression in the variable-length or running-status handling shows up as a
 * wrong offset instead of a subtly wrong file that only fails on hardware.
 * The fixture reproduces the two things that actually break naive parsers - a
 * meta event with a multi-byte length, and running status.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSff, readChunks, findMidiPayloads } from '../src/sff.js';
import { indexNotes, indexTracksOnly, applyVelocity, noteName, readVarLen } from '../src/smf.js';

/** Build an SMF track from raw event bytes, prefixing the MTrk header. */
function track(events) {
  const len = events.length;
  return Uint8Array.from([
    0x4d, 0x54, 0x72, 0x6b, // "MTrk"
    (len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff,
    ...events,
  ]);
}

/** Standard MIDI File header for `nTracks`. */
function mthd(nTracks) {
  return Uint8Array.from([
    0x4d, 0x54, 0x68, 0x64, // "MThd"
    0, 0, 0, 6,
    0, 1, // format 1
    (nTracks >>> 8) & 0xff, nTracks & 0xff,
    0x01, 0x18, // 480 ticks per quarter
  ]);
}

/**
 * Wrap a payload in an SFF chunk. The id is exactly four bytes - Yamaha pads
 * three-character ids like "MID" with a trailing null, so the id must be padded
 * here rather than relying on the reader to trim it.
 */
function chunk(id, payload) {
  const out = new Uint8Array(8 + payload.length);
  for (let i = 0; i < 4; i++) out[i] = i < id.length ? id.charCodeAt(i) : 0;
  const len = payload.length;
  out[4] = (len >>> 24) & 0xff;
  out[5] = (len >>> 16) & 0xff;
  out[6] = (len >>> 8) & 0xff;
  out[7] = len & 0xff;
  out.set(payload, 8);
  return out;
}

function concat(parts) {
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const part of parts) {
    out.set(part, p);
    p += part.length;
  }
  return out;
}

/** A complete SFF2 style: header, Smed with MID + MER, and a metadata chunk. */
function buildSty({ magic = [0x53, 0x46, 0x46, 0x32] } = {}) {
  const headerLength = 4;
  const trk = track([
    // Note On ch1 (0x90) note 60 velocity 100
    0x00, 0x90, 60, 100,
    // Meta text, length 5 - the case that desyncs a parser that skips one byte
    0x00, 0xff, 0x01, 0x05, 0x68, 0x65, 0x6c, 0x6c, 0x6f,
    // Note On ch10 (drums) note 36 velocity 90 - sets running status to 0x99
    0x00, 0x99, 36, 90,
    // Running status: bare note data, no status byte, still a note ON
    0x00, 38, 85,
    // Note Off last, so it cannot change the running status before the above
    0x60, 0x89, 36, 0,
  ]);
  const smf = concat([mthd(1), trk]);
  const med = chunk('Smed', concat([chunk('MID', smf), chunk('MER', smf)]));
  const ins = chunk('Sins', Uint8Array.from([1, 2, 3, 4]));
  const body = concat([med, ins]);

  const head = new Uint8Array(8 + 4);
  head.set(magic, 0);
  // The SFF2 length field counts its own four bytes.
  head[4] = 0; head[5] = 0; head[6] = 0; head[7] = 8;
  head.set([0x53, 0x53, 0x54, 0x4e], 8);

  return concat([head, body]).buffer;
}

test('readSff accepts SFF2 and reports the version', () => {
  const { isSff2, chunks } = readSff(buildSty());
  assert.equal(isSff2, true);
  assert.deepEqual(chunks.map((c) => c.id), ['Smed', 'Sins']);
});

test('readSff accepts SFF1, which has no header length field', () => {
  // SFF1 is the magic plus the chunk list: no 4-byte length, no SSTN. Build it
  // directly rather than deriving it from the SFF2 fixture, so the test does not
  // depend on how the SFF2 header happens to be shaped.
  const smf = concat([mthd(1), track([0x00, 0x90, 60, 100, 0x60, 0x89, 60, 0])]);
  const body = concat([chunk('Smed', chunk('MID', smf)), chunk('Sins', Uint8Array.from([1, 2, 3, 4]))]);
  const head = Uint8Array.from([0x53, 0x46, 0x46, 0x20]); // "SFF " + trailing space
  const sty = concat([head, body]);

  const buf = sty.buffer.slice(sty.byteOffset, sty.byteOffset + sty.byteLength);
  const { isSff2, chunks } = readSff(buf);

  assert.equal(isSff2, false);
  assert.deepEqual(chunks.map((c) => c.id), ['Smed', 'Sins']);

  // And the payload must still be reachable in the older container.
  const { payloads } = findMidiPayloads(buf);
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].kind, 'MID');
  assert.equal(indexNotes(buf, payloads[0].offset, payloads[0].size).notes.length, 1);
});

test('readSff rejects a non-SFF file with a readable message', () => {
  const junk = new Uint8Array(64).fill(0x41).buffer;
  assert.throws(() => readSff(junk), /Not a Yamaha SFF file/);
});

test('readChunks stops instead of emitting a chunk that runs past the end', () => {
  const view = new DataView(Uint8Array.from([0x4d, 0x49, 0x44, 0x00, 0xff, 0xff, 0xff, 0xff]).buffer);
  // Declared length is absurdly large, so the walk must bail rather than
  // return a chunk whose data lies outside the buffer.
  assert.deepEqual(readChunks(view, 0, view.byteLength), []);
});

test('findMidiPayloads locates both MID and MER with SMF metadata', () => {
  const info = findMidiPayloads(buildSty());
  assert.equal(info.version, 'SFF2');
  assert.equal(info.payloads.length, 2);
  assert.deepEqual(info.payloads.map((p) => p.kind), ['MID', 'MER']);
  for (const p of info.payloads) {
    assert.equal(p.format, 1);
    assert.equal(p.tracks, 1);
  }
  // The second payload must start after the first, at the right stride.
  assert.equal(info.payloads[1].offset - info.payloads[0].offset, info.payloads[0].size + 8);
});

test('readVarLen decodes multi-byte quantities', () => {
  const v = new DataView(Uint8Array.from([0x81, 0x00]).buffer);
  assert.deepEqual(readVarLen(v, 0, 2), { value: 128, next: 2 });
  const v2 = new DataView(Uint8Array.from([0xc0, 0x00]).buffer);
  assert.deepEqual(readVarLen(v2, 0, 2), { value: 8192, next: 2 });
});

test('indexNotes finds every note-on, including under running status', () => {
  // The single most important invariant: velocityOffset must be an absolute
  // index into the original buffer that lands on the velocity byte. A patch
  // written to the wrong offset still produces a file the player accepts, it
  // just plays the original dynamics, so only an assertion that reads the byte
  // back can catch it.
  const buf = buildSty();
  const bytes = new Uint8Array(buf);
  const { payloads } = findMidiPayloads(buf);
  const { notes } = indexNotes(buf, payloads[0].offset, payloads[0].size);

  assert.ok(notes.length >= 3);
  for (const n of notes) {
    assert.equal(bytes[n.velocityOffset], n.velocity, `byte at ${n.velocityOffset} holds the velocity`);
    // The byte before it is the note number, which must be 0-127 and match.
    assert.equal(bytes[n.velocityOffset - 1], n.note, 'preceding byte is the note number');
  }
});

test('indexNotes reports offsets that address the real velocity byte', () => {
  const buf = buildSty();
  const { payloads } = findMidiPayloads(buf);
  const { notes } = indexNotes(buf, payloads[0].offset, payloads[0].size);

  assert.equal(notes.length, 3, 'note 60 ch1, note 36 ch10, running-status note 38');
  assert.deepEqual(notes.map((n) => [n.note, n.velocity, n.channel]), [
    [60, 100, 0],
    [36, 90, 9],
    [38, 85, 9],
  ]);
});

test('indexNotes survives a meta event without inventing notes', () => {
  const buf = buildSty();
  const { payloads } = findMidiPayloads(buf);
  const { notes } = indexNotes(buf, payloads[0].offset, payloads[0].size);
  // If the 5-byte meta body were skipped wrongly, the bytes after it would be
  // read as status/data and produce a bogus fourth note.
  assert.ok(!notes.some((n) => n.note === 0x01 || n.note === 0x05));
  assert.ok(notes.every((n) => n.velocityOffset > 0));
});

test('MID and MER parse to the same note set', () => {
  const buf = buildSty();
  const { payloads } = findMidiPayloads(buf);
  const a = indexNotes(buf, payloads[0].offset, payloads[0].size).notes;
  const b = indexNotes(buf, payloads[1].offset, payloads[1].size).notes;
  assert.deepEqual(
    a.map((n) => [n.note, n.velocity, n.channel]),
    b.map((n) => [n.note, n.velocity, n.channel]),
  );
});

test('noteName spans the full range the user cares about', () => {
  assert.equal(noteName(0), 'C-1');
  assert.equal(noteName(36), 'C2');
  assert.equal(noteName(60), 'C4');
  assert.equal(noteName(127), 'G9');
});

test('applyVelocity writes only the targeted bytes', () => {
  const buf = buildSty();
  const before = new Uint8Array(buf);
  const { payloads } = findMidiPayloads(buf);
  const { notes } = indexNotes(buf, payloads[0].offset, payloads[0].size);
  const out = applyVelocity(buf, notes, 127);
  const after = new Uint8Array(out);

  // Every differing byte must be a velocity byte we asked for.
  const diff = [];
  for (let i = 0; i < before.length; i++) if (before[i] !== after[i]) diff.push(i);
  assert.equal(diff.length, notes.length);
  assert.deepEqual(diff, notes.map((n) => n.velocityOffset));
  for (const i of diff) assert.equal(after[i], 127);

  // And the header must be untouched.
  assert.deepEqual([...after.slice(0, 8)], [...before.slice(0, 8)]);
  // Length: preserved exactly.
  assert.equal(out.byteLength, buf.byteLength);
});

test('applyVelocity clamps out-of-range input instead of corrupting the byte', () => {
  const buf = buildSty();
  const { payloads } = findMidiPayloads(buf);
  const { notes } = indexNotes(buf, payloads[0].offset, payloads[0].size);
  assert.equal(new Uint8Array(applyVelocity(buf, notes, 300))[notes[0].velocityOffset], 127);
  assert.equal(new Uint8Array(applyVelocity(buf, notes, 0))[notes[0].velocityOffset], 1);
});

test('patching MID and MER together keeps both payloads in sync', () => {
  const buf = buildSty();
  const { payloads } = findMidiPayloads(buf);
  assert.equal(payloads.length, 2, 'fixture must carry both MID and MER');
  const mid = indexNotes(buf, payloads[0].offset, payloads[0].size).notes;
  const mer = indexNotes(buf, payloads[1].offset, payloads[1].size).notes;

  // The two copies hold the same music at different offsets. If their offsets
  // overlapped, patching would only fix one of them and the style would sound
  // unchanged on half the hardware in the family.
  const midOffsets = new Set(mid.map((n) => n.velocityOffset));
  assert.ok(mer.every((n) => !midOffsets.has(n.velocityOffset)), 'offsets must not overlap');

  const out = applyVelocity(buf, [...mid, ...mer], 40);

  // Re-parse the result and confirm both copies report the new velocity.
  const check = findMidiPayloads(out);
  assert.equal(check.payloads.length, 2);
  for (const p of check.payloads) {
    const { notes } = indexNotes(out, p.offset, p.size);
    assert.ok(notes.length > 0, `${p.kind} still has notes`);
    assert.deepEqual(
      notes.map((n) => n.velocity),
      notes.map(() => 40),
      `${p.kind} all at 40`,
    );
  }
});

test('applyVelocity does not mutate the input buffer', () => {
  // Regression guard. Constructing a Uint8Array over an existing ArrayBuffer
  // aliases it rather than copying, so an in-place implementation would edit
  // the user's original file - silently, since the function still returns
  // something that looks like a result.
  const buf = buildSty();
  const snapshot = new Uint8Array(buf);
  const { payloads } = findMidiPayloads(buf);
  const { notes } = indexNotes(buf, payloads[0].offset, payloads[0].size);

  const out = applyVelocity(buf, notes, 111);

  assert.notEqual(out, buf, 'must return a distinct buffer');
  assert.deepEqual([...new Uint8Array(buf)], [...snapshot], 'input must be byte-identical');
  assert.ok(
    notes.some((n) => snapshot[n.velocityOffset] !== 111),
    'the fixture must actually contain velocities that needed changing',
  );
});

test('a payload with tracks but no MThd is still readable', () => {
  // Some writers store the second copy of a performance as a bare run of MTrk
  // chunks with proprietary header bytes in front. Refusing it would mean the
  // edit reaches only one copy of the music.
  const trk = track([
    0x00, 0x99, 36, 100,
    0x60, 0x89, 36, 0,
    0x00, 0x99, 42, 90,
    0x60, 0x89, 42, 0,
  ]);
  const junk = Uint8Array.from([0x00, 0x00, 0x00, 0x00, 0x01, 0x20]); // proprietary prefix
  const bare = concat([junk, trk]);

  // indexNotes must refuse it...
  const refusal = indexNotes(bare.buffer.slice(0), 0, bare.length);
  assert.match(refusal.error, /no MThd/);

  // ...and indexTracksOnly must handle it.
  const r = indexTracksOnly(bare.buffer.slice(0), 0, bare.length);
  assert.equal(r.layout, 'tracks-only');
  assert.equal(r.tracks, 1);
  assert.deepEqual(r.notes.map((n) => [n.note, n.velocity, n.channel]), [
    [36, 100, 9],
    [42, 90, 9],
  ]);
});

test('indexTracksOnly yields offsets that address the real velocity byte', () => {
  const trk = track([0x00, 0x99, 36, 77, 0x60, 0x89, 36, 0]);
  const bare = concat([Uint8Array.from([1, 2, 3, 4]), trk]);
  const bytes = new Uint8Array(bare.buffer, bare.byteOffset, bare.byteLength);
  const r = indexTracksOnly(bytes.buffer.slice(0), 0, bare.length);
  assert.ok(r.notes.length === 1);
  assert.equal(bytes[r.notes[0].velocityOffset], 77);
});

test('a payload with neither MThd nor MTrk reports nothing rather than guessing', () => {
  const junk = new Uint8Array(512).fill(0x00);
  const r = indexTracksOnly(junk.buffer, 0, junk.length);
  assert.equal(r.notes.length, 0);
  assert.equal(r.tracks, 0);
});

test('a truncated payload yields an error rather than a bogus index', () => {
  const buf = buildSty();
  assert.ok(indexNotes(buf, 0, 4).error);
  const { payloads } = findMidiPayloads(buf);
  assert.ok(indexNotes(buf, payloads[0].offset + 3, payloads[0].size).error);
});



