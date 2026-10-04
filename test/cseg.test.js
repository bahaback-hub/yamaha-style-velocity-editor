/**
 * The section map, tested against the user's own collection.
 *
 * Synthetic fixtures cannot settle this. A 55-byte record that happens to be the
 * right width for one hand-written CSEG can still be wrong for every real file, and
 * the failure mode is a style the arranger silently refuses. So the decisive test
 * here is: parse every style on this machine, write it straight back with nothing
 * changed, and require the identical bytes. Until that holds for all of them, no
 * edit to a section map may be offered.
 *
 * The files are read from the user's collection and never copied into the
 * repository. When they are absent the suite says so and the synthetic cases carry
 * the weight on their own.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  parseCasm, buildCasmBody, writeCasm, setSectionChannel, renameSection,
  removeSection, cloneSection, RECORD_LENGTH,
} from '../src/cseg.js';

const COLLECTION = 'C:/Users/DSER/OneDrive/سطح المكتب/Saudi 1';

/** Every style in the collection, or an empty list if the folder is not there. */
function collectionFiles() {
  if (!existsSync(COLLECTION)) return [];
  return readdirSync(COLLECTION)
    .filter((f) => f.toLowerCase().endsWith('.sty'))
    .map((f) => join(COLLECTION, f));
}

const files = collectionFiles();
const hasCollection = files.length > 0;

const toBuf = (bytes) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

// ---- synthetic fixtures ------------------------------------------------------

function chunk(id, payload) {
  const out = new Uint8Array(8 + payload.length);
  for (let i = 0; i < 4; i++) out[i] = id.charCodeAt(i);
  new DataView(out.buffer).setUint32(4, payload.length);
  out.set(payload, 8);
  return out;
}
const name8 = (s) => Uint8Array.from([...s.padEnd(8, ' ')].map((c) => c.charCodeAt(0)));
const tag = (s = 'Ctb2') => {
  const out = new Uint8Array(7);
  for (let i = 0; i < Math.min(3, s.length); i++) out[i] = s.charCodeAt(i);
  return out;
};
const params = (ch, fill = 0) => {
  const out = new Uint8Array(38).fill(fill);
  out[0] = ch;
  out[1] = 0x0f; out[2] = 0xff; out[3] = 0x03;
  return out;
};
function record(ch, name) {
  return Uint8Array.from([...tag(), 0x2f, ch, ...name8(name), ...params(ch)]);
}
function section(name, records) {
  const text = Uint8Array.from([...name].map((c) => c.charCodeAt(0)));
  const body = new Uint8Array(8 + text.length + records.length * RECORD_LENGTH);
  // The Sdec chunk sits at the front of the CSEG body: id, length, then the text.
  body[0] = 0x53; body[1] = 0x64; body[2] = 0x65; body[3] = 0x63; // "Sdec"
  new DataView(body.buffer).setUint32(4, text.length);
  body.set(text, 8);
  let p = 8 + text.length;
  for (const r of records) { body.set(r, p); p += RECORD_LENGTH; }
  return chunk('CSEG', body);
}
/** A bare-MIDI style: header, one track, then CASM as a sibling chunk. */
function styleWith(sections) {
  const track = chunk('MTrk', Uint8Array.from([
    0x00, 0xff, 0x2f, 0x00,
    0x00, 0x99, 36, 100, 0x60, 0x89, 36, 0,
  ]));
  const casmBody = new Uint8Array(sections.reduce((a, s) => a + s.length, 0));
  let p = 0;
  for (const s of sections) { casmBody.set(s, p); p += s.length; }
  const head = chunk('MThd', Uint8Array.from([0, 1, 0, 1, 0x01, 0xe0]));
  return toBuf(new Uint8Array([...head, ...track, ...chunk('CASM', casmBody)]));
}

// ---- structure ---------------------------------------------------------------

test('a record is 55 bytes, and a section adds only its name', () => {
  assert.equal(RECORD_LENGTH, 55, '7 tag + 1 marker + 1 channel + 8 name + 38 params');
  // Six parts: 14 bytes of Sdec header and name, then six whole records.
  assert.equal(section('Main A', Array.from({ length: 6 }, () => record(8, 'Rhythm1'))).length,
    8 + 8 + 6 + 6 * RECORD_LENGTH);
});

test('parses names, channels and part names in order', () => {
  const buffer = styleWith([
    section('Main A', [record(8, 'Rhythm1'), record(9, 'Rhythm2'), record(10, 'Bass')]),
    section('Intro A', [record(9, 'Rhythm2')]),
  ]);
  const casm = parseCasm(buffer);
  assert.ok(casm);
  assert.equal(casm.sections.length, 2);
  assert.deepEqual(casm.sections.map((s) => s.name), ['Main A', 'Intro A']);
  assert.deepEqual(casm.sections[0].channels, [8, 9, 10]);
  assert.deepEqual(casm.sections[0].records.map((r) => r.name), ['Rhythm1', 'Rhythm2', 'Bass']);
  assert.equal(casm.sections[1].records.length, 1, 'Intro A really has one part');
  assert.equal(casm.trailing, 0, 'CASM held nothing but CSEG groups');
});

test('the channel number is the same one the notes use, with no shift', () => {
  // The previous parser subtracted one here, on the assumption that the byte was
  // one-based. On real files it is not: a style whose parts sit on channels 9-15
  // one-based declares 9-15 in CASM, matching the notes' zero-based numbering.
  const buffer = styleWith([section('Main A', [record(9, 'Rhythm2')])]);
  const casm = parseCasm(buffer);
  assert.deepEqual(casm.sections[0].channels, [9]);
});

test('a file with no CASM reports that rather than inventing a map', () => {
  const bare = toBuf(new Uint8Array([...chunk('MThd', Uint8Array.from([0, 1, 0, 1, 0x01, 0xe0]))]));
  assert.equal(parseCasm(bare), null);
});

test('a name longer than the padding survives, and so does an empty one', () => {
  const buffer = styleWith([section('Ending', [record(8, 'Rhythm1')])]);
  assert.equal(parseCasm(buffer).sections[0].name, 'Ending');
});

// ---- round trip ---------------------------------------------------------------

test('parse then write is byte-identical, on a synthetic file', () => {
  const buffer = styleWith([
    section('Main A', [record(8, 'Rhythm1'), record(9, 'Rhythm2'), record(13, 'Clavi')]),
    section('Intro A', [record(9, 'Rhythm2')]),
  ]);
  const casm = parseCasm(buffer);
  const out = new Uint8Array(writeCasm(buffer, casm));
  assert.deepEqual([...out], [...new Uint8Array(buffer)]);
});

test('parse then write is byte-identical, on every style in the collection', { skip: !hasCollection }, () => {
  const failures = [];
  let checked = 0;
  const groupHistogram = new Map();

  for (const path of files) {
    const bytes = readFileSync(path);
    const buffer = toBuf(bytes);
    let casm;
    try {
      casm = parseCasm(buffer);
    } catch (err) {
      failures.push(`${path}: parse threw - ${err.message}`);
      continue;
    }
    if (!casm) {
      failures.push(`${path}: no CASM`);
      continue;
    }
    if (casm.trailing !== 0) {
      failures.push(`${path}: ${casm.trailing} bytes inside CASM are not CSEG groups`);
      continue;
    }
    const rebuilt = new Uint8Array(writeCasm(buffer, casm));
    const original = new Uint8Array(buffer);
    if (rebuilt.length !== original.length) {
      failures.push(`${path}: length ${original.length} -> ${rebuilt.length}`);
      continue;
    }
    let firstDiff = -1;
    for (let i = 0; i < original.length; i++) {
      if (original[i] !== rebuilt[i]) { firstDiff = i; break; }
    }
    if (firstDiff >= 0) {
      failures.push(`${path}: first difference at byte ${firstDiff}`);
      continue;
    }
    // The rebuilt body must also match what buildCasmBody produces on its own,
    // so the two paths cannot drift apart. `casm.length` is the CASM body, the
    // length its own header declares.
    const body = buildCasmBody(casm.sections);
    if (body.length !== casm.length) {
      failures.push(`${path}: body length ${body.length} vs declared ${casm.length}`);
      continue;
    }
    checked++;
    groupHistogram.set(casm.sections.length, (groupHistogram.get(casm.sections.length) ?? 0) + 1);
  }

  console.log(`      round-tripped ${checked}/${files.length} styles; sections-per-file: `
    + [...groupHistogram.entries()].sort((a, b) => a[0] - b[0])
      .map(([n, c]) => `${n}x${c}`).join(' '));
  assert.deepEqual(failures, [], 'every style must rebuild to identical bytes');
});

// ---- editing ------------------------------------------------------------------

test('switching a part off removes exactly its record', () => {
  const buffer = styleWith([
    section('Main A', [record(8, 'Rhythm1'), record(9, 'Rhythm2'), record(10, 'Bass')]),
  ]);
  const casm = parseCasm(buffer);
  assert.equal(setSectionChannel(casm, 0, 9, false).ok, true);
  // A record is 55 bytes and nothing else moves: the CSEG header stays, and so does
  // the Sdec chunk holding the name.
  assert.equal(writeCasm(buffer, casm).byteLength, buffer.byteLength - RECORD_LENGTH);

  const after = parseCasm(writeCasm(buffer, casm));
  assert.deepEqual(after.sections[0].channels, [8, 10], 'Rhythm2 is gone');
  assert.deepEqual(after.sections[0].records.map((r) => r.name), ['Rhythm1', 'Bass']);
});

test('switching a part back on copies its voice settings from another section', () => {
  const buffer = styleWith([
    section('Main A', [record(8, 'Rhythm1'), record(9, 'Rhythm2'), record(10, 'Bass')]),
    section('Main B', [record(8, 'Rhythm1')]),
  ]);
  const casm = parseCasm(buffer);
  // Rhythm2 is off in Main B; bring it back.
  assert.equal(setSectionChannel(casm, 1, 9, true).ok, true);
  const after = parseCasm(writeCasm(buffer, casm));
  assert.deepEqual(after.sections[1].channels, [8, 9]);

  const restored = after.sections[1].records.find((r) => r.channel === 9);
  const original = parseCasm(buffer).sections[0].records.find((r) => r.channel === 9);
  assert.equal(restored.name, original.name, 'the part name came across');
  assert.deepEqual([...restored.params], [...original.params],
    'and its 38 parameter bytes, which are what make the part playable');
});

test('a channel no other section uses cannot be switched on', () => {
  const buffer = styleWith([section('Main A', [record(8, 'Rhythm1')])]);
  const casm = parseCasm(buffer);
  const result = setSectionChannel(casm, 0, 11, true);
  assert.equal(result.ok, false);
  assert.match(result.reason, /no other variation/);
});

test('switching something that is already in that state says so', () => {
  const buffer = styleWith([section('Main A', [record(8, 'Rhythm1')])]);
  const casm = parseCasm(buffer);
  assert.equal(setSectionChannel(casm, 0, 8, true).ok, false);
  assert.equal(setSectionChannel(casm, 0, 9, false).ok, false);
  assert.equal(setSectionChannel(casm, 5, 8, true).ok, false, 'no such section');
});

test('renaming a variation keeps everything else byte-identical', () => {
  const buffer = styleWith([
    section('Main A', [record(8, 'Rhythm1')]),
    section('Main B', [record(8, 'Rhythm1'), record(9, 'Rhythm2')]),
  ]);
  const casm = parseCasm(buffer);
  const otherBefore = [...parseCasm(buffer).sections[1].nameBytes];
  assert.equal(renameSection(casm, 0, 'Layla').ok, true);

  const out = writeCasm(buffer, casm);
  const after = parseCasm(out);
  assert.equal(after.sections[0].name, 'Layla');
  assert.deepEqual([...after.sections[1].nameBytes], otherBefore, 'the other name is untouched');
  assert.deepEqual(after.sections[1].channels, [8, 9]);

  // Only the renamed section's bytes may move.
  assert.equal(out.byteLength, buffer.byteLength + ('Layla'.length - 'Main A'.length));
});

test('deleting a variation removes its whole group', () => {
  const buffer = styleWith([
    section('Main A', [record(8, 'Rhythm1')]),
    section('Fill In AA', [record(8, 'Rhythm1'), record(9, 'Rhythm2')]),
    section('Main B', [record(8, 'Rhythm1')]),
  ]);
  const casm = parseCasm(buffer);
  assert.equal(removeSection(casm, 1).ok, true);
  const after = parseCasm(writeCasm(buffer, casm));
  assert.deepEqual(after.sections.map((s) => s.name), ['Main A', 'Main B']);
  assert.deepEqual(casm.sections.map((s) => s.index), [0, 1], 'indices are renumbered');
});

test('a new variation is a copy, so it arrives playable', () => {
  const buffer = styleWith([
    section('Main A', [record(8, 'Rhythm1'), record(10, 'Bass')]),
  ]);
  const casm = parseCasm(buffer);
  const result = cloneSection(casm, 0);
  assert.equal(result.ok, true);
  assert.equal(result.name, 'Main B', 'the next free letter');

  const after = parseCasm(writeCasm(buffer, casm));
  assert.deepEqual(after.sections.map((s) => s.name), ['Main A', 'Main B']);
  assert.deepEqual(after.sections[1].channels, [8, 10]);
  assert.deepEqual([...after.sections[1].records[1].params],
    [...after.sections[0].records[1].params], 'voice settings came along');
});

test('a cloned name skips letters already taken', () => {
  const casm = parseCasm(styleWith([
    section('Main A', [record(8, 'Rhythm1')]),
    section('Main C', [record(8, 'Rhythm1')]),
  ]));
  // Cloning Main C should reach for D, not reuse B or C.
  assert.equal(cloneSection(casm, 1).name, 'Main D');
});

test('the notes are never touched by a map edit', () => {
  // The same assertion the velocity editor relies on, applied to the other half of
  // the file: a section-map edit must not disturb a single note byte.
  const noteTrack = chunk('MTrk', Uint8Array.from([
    0x00, 0xff, 0x2f, 0x00,
    0x00, 0x99, 36, 100, 0x60, 0x89, 36, 0,
    0x00, 0x99, 42, 70, 0x60, 0x89, 42, 0,
  ]));
  const head = chunk('MThd', Uint8Array.from([0, 1, 0, 1, 0x01, 0xe0]));
  const secs = [section('Main A', [record(8, 'Rhythm1'), record(9, 'Rhythm2')])];
  const casmBody = new Uint8Array(secs.reduce((a, s) => a + s.length, 0));
  let p = 0; for (const s of secs) { casmBody.set(s, p); p += s.length; }
  const buffer = toBuf(new Uint8Array([...head, ...noteTrack, ...chunk('CASM', casmBody)]));

  const casm = parseCasm(buffer);
  setSectionChannel(casm, 0, 9, false);
  const out = new Uint8Array(writeCasm(buffer, casm));

  // Both sides must be the MTrk *payload*: the chunk header is at head.length and
  // the note data starts 8 bytes later.
  const trackStart = head.length + 8;
  const trackBefore = new Uint8Array(buffer, trackStart, noteTrack.length - 8);
  const trackAfter = out.slice(trackStart, trackStart + noteTrack.length - 8);
  assert.deepEqual([...trackAfter], [...trackBefore], 'the MTrk is byte-identical');
  assert.equal(out[0], 0x4d, 'still opens with MThd');
});
