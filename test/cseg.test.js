/**
 * The section map, tested against the user's own collection.
 *
 * Synthetic fixtures cannot settle this. A 47-byte body that happens to be the
 * right width for one hand-written entry can still be wrong for every real file,
 * and the failure mode is a style the arranger silently refuses. So the decisive
 * test here is: parse every style on this machine, write it straight back with
 * nothing changed, and require the identical bytes. Until that holds for all of
 * them, no edit to a section map may be offered.
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
  removeSection, cloneSection, applyCasmOperations, casmWithEdits, styleParts,
  CTB2_BODY, NOTE_CLASSES, CHORD_TYPES,
} from '../src/cseg.js';

const COLLECTION = 'C:/Users/DSER/OneDrive/سطح المكتب/Saudi 1';

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

/** A part entry in the documented shape: Ctb2, length 47, then the body. */
function part(channel, partName, patch = {}) {
  const body = new Uint8Array(CTB2_BODY);
  body[0] = channel;
  body.set(name8(partName), 1, 8);
  body[9] = channel;                       // destination channel
  body[10] = 0;                            // editable
  // Note play: every one of the twelve pitch classes. Bit n of the mask is pitch
  // class n, so all twelve is 0x0FFF - low byte 0xFF, high byte 0x0F. (The real
  // files store 0xFF0F, whose bits 4 to 7 are clear; that is eight notes.)
  body[11] = 0xff; body[12] = 0x0f;
  body[18] = 0;                            // chord key C
  body[19] = 0;                            // chord type Maj
  body[20] = 0; body[21] = 127;            // middle notes, full range
  for (const at of [22, 28, 34]) {
    body[at] = 0;                          // note type: root-transposed
    body[at + 1] = 1;                      // chord limit: melody
    body[at + 2] = 0;                      // high key C
    body[at + 3] = 0;                      // low limit
    body[at + 4] = 127;                    // high limit
    body[at + 5] = 0;                      // retrigger: stop
  }
  Object.assign(body, patch);
  return chunk('Ctb2', body);
}

function section(sectionName, parts) {
  const text = Uint8Array.from([...sectionName].map((c) => c.charCodeAt(0)));
  const partsLength = parts.reduce((a, p) => a + p.length, 0);
  const body = new Uint8Array(8 + text.length + partsLength);
  body[0] = 0x53; body[1] = 0x64; body[2] = 0x65; body[3] = 0x63; // "Sdec"
  new DataView(body.buffer).setUint32(4, text.length);
  body.set(text, 8);
  let p = 8 + text.length;
  for (const part of parts) { body.set(part, p); p += part.length; }
  return chunk('CSEG', body);
}

/** A bare-MIDI style: header, one track, then CASM as a sibling chunk. */
function styleWith(sections) {
  const track = chunk('MTrk', Uint8Array.from([
    0x00, 0xff, 0x2f, 0x00,
    0x00, 0x99, 36, 100, 0x60, 0x89, 36, 0,
  ]));
  const groups = sections;
  const total = groups.reduce((a, s) => a + s.length, 0);
  const body = new Uint8Array(total);
  let p = 0;
  for (const g of groups) { body.set(g, p); p += g.length; }
  const head = chunk('MThd', Uint8Array.from([0, 1, 0, 1, 0x01, 0xe0]));
  return toBuf(new Uint8Array([...head, ...track, ...chunk('CASM', body)]));
}

// ---- structure ---------------------------------------------------------------

test('a part body is 47 bytes and the whole entry is 55', () => {
  assert.equal(CTB2_BODY, 47);
  // 8 bytes of chunk header and length, then the body.
  assert.equal(part(9, 'Drums').length, 8 + CTB2_BODY);
  assert.equal(part(9, 'Drums').length, 55);
});

test('parses names, channels and part names in order', () => {
  const buffer = styleWith([
    section('Main A', [part(8, 'Rhythm1'), part(9, 'Rhythm2'), part(10, 'Bass')]),
    section('Intro A', [part(9, 'Rhythm2')]),
  ]);
  const casm = parseCasm(buffer);
  assert.ok(casm);
  assert.deepEqual(casm.sections.map((s) => s.name), ['Main A', 'Intro A']);
  assert.deepEqual(casm.sections[0].channels, [8, 9, 10]);
  assert.deepEqual(casm.sections[0].parts.map((r) => r.name), ['Rhythm1', 'Rhythm2', 'Bass']);
  assert.equal(casm.sections[1].parts.length, 1);
  assert.equal(casm.trailing, 0);
  assert.deepEqual(casm.entryTypes.sort(), ['Ctb2', 'Sdec']);
});

test('decodes the documented fields, not a blob', () => {
  const buffer = styleWith([section('Main A', [part(10, 'Bass', { 18: 7, 19: 8 })])]);
  const casm = parseCasm(buffer);
  const p = casm.sections[0].parts[0];
  assert.equal(p.channel, 10, 'source channel');
  assert.equal(p.name, 'Bass');
  assert.equal(p.destinationChannel, 10);
  assert.equal(p.editable, false);
  assert.equal(p.chordKey, 7);
  assert.equal(p.chordKeyName, 'G');
  assert.equal(p.chordType, 8);
  assert.equal(p.chordTypeName, CHORD_TYPES[8], 'the enum names the chord type');
  assert.equal(p.notePlay.length, 12, 'a 0x0FFF mask covers all twelve pitch classes');
  assert.deepEqual(p.notePlay, NOTE_CLASSES);
  assert.equal(p.middleLow, 0);
  assert.equal(p.middleHigh, 127);
  for (const range of [p.low, p.middle, p.high]) {
    assert.equal(range.highLimit, 127);
    assert.equal(range.noteType, 0);
  }
});

test('a note-play mask with gaps decodes to the gaps', () => {
  // Every part in the real collection stores 0xFF0F, which leaves bits 4 to 7
  // clear: E, F, F# and G do not trigger the part. That is the mask as the file
  // writes it, and reading it as "all twelve" would be a silent misreading.
  const buffer = styleWith([section('Main A', [part(11, 'Chord1', { 11: 0x0f, 12: 0xff })])]);
  const p = parseCasm(buffer).sections[0].parts[0];
  assert.equal(p.notePlayMask, 0xff0f);
  assert.deepEqual(p.notePlay, ['C', 'C#', 'D', 'D#', 'G#', 'A', 'A#', 'B']);
  assert.ok(!p.notePlay.includes('E'));
  assert.ok(!p.notePlay.includes('G'));
});

test('an entry type this reader does not know is stepped over, not misread', () => {
  // A Cntt entry between the Sdec and the parts. It has to be skipped using its
  // own declared length, and the parts after it must still be found.
  const cntt = chunk('Cntt', new Uint8Array(12).fill(0xab));
  const buffer = styleWith([section('Main A', [cntt, part(9, 'Drums'), part(11, 'Bass')])]);
  const casm = parseCasm(buffer);
  assert.deepEqual(casm.sections[0].parts.map((r) => r.name), ['Drums', 'Bass']);
  assert.ok(casm.entryTypes.includes('Cntt'), 'and it is reported as seen');
});

test('the channel number is the same one the notes use, with no shift', () => {
  // The previous reader subtracted one here. On real files the byte is not
  // one-based: a style whose parts sit on channels 9-15 declares 9-15.
  const buffer = styleWith([section('Main A', [part(9, 'Rhythm2')])]);
  assert.deepEqual(parseCasm(buffer).sections[0].channels, [9]);
});

test('a file with no CASM reports that rather than inventing a map', () => {
  const bare = toBuf(new Uint8Array([...chunk('MThd', Uint8Array.from([0, 1, 0, 1, 0x01, 0xe0]))]));
  assert.equal(parseCasm(bare), null);
});

// ---- round trip ---------------------------------------------------------------

test('parse then write is byte-identical, on a synthetic file', () => {
  const buffer = styleWith([
    section('Main A', [part(8, 'Rhythm1'), part(9, 'Rhythm2'), part(13, 'Clavi')]),
    section('Intro A', [part(9, 'Rhythm2')]),
  ]);
  const casm = parseCasm(buffer);
  assert.deepEqual([...new Uint8Array(writeCasm(buffer, casm))], [...new Uint8Array(buffer)]);
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
    if (!casm) { failures.push(`${path}: no CASM`); continue; }
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
    // The rebuilt body must also match buildCasmBody on its own, so the two
    // write paths cannot drift apart.
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

test('every part in the collection has a 47-byte body', { skip: !hasCollection }, () => {
  const bad = [];
  let parts = 0;
  for (const path of files) {
    const buffer = toBuf(readFileSync(path));
    const casm = parseCasm(buffer);
    if (!casm) continue;
    for (const s of casm.sections) {
      for (const p of s.parts) {
        parts++;
        if (p.length !== CTB2_BODY) bad.push(`${path}: ${p.name} declares ${p.length}`);
      }
    }
  }
  console.log(`      ${parts} part entries, all ${CTB2_BODY} bytes`);
  assert.deepEqual(bad, []);
});

// ---- editing ------------------------------------------------------------------

test('switching a part off removes exactly its entry', () => {
  const buffer = styleWith([
    section('Main A', [part(8, 'Rhythm1'), part(9, 'Rhythm2'), part(10, 'Bass')]),
  ]);
  const casm = parseCasm(buffer);
  assert.equal(setSectionChannel(casm, 0, 9, false).ok, true);
  // A whole entry goes: its eight-byte header and its 47-byte body.
  assert.equal(writeCasm(buffer, casm).byteLength, buffer.byteLength - 55);

  const after = parseCasm(writeCasm(buffer, casm));
  assert.deepEqual(after.sections[0].channels, [8, 10], 'Rhythm2 is gone');
  assert.deepEqual(after.sections[0].parts.map((r) => r.name), ['Rhythm1', 'Bass']);
});

test('switching a part back on copies every field from another section', () => {
  const buffer = styleWith([
    section('Main A', [part(8, 'Rhythm1'), part(9, 'Rhythm2', { 19: 8 }), part(10, 'Bass')]),
    section('Main B', [part(8, 'Rhythm1')]),
  ]);
  const casm = parseCasm(buffer);
  assert.equal(setSectionChannel(casm, 1, 9, true).ok, true);
  const after = parseCasm(writeCasm(buffer, casm));
  assert.deepEqual(after.sections[1].channels, [8, 9]);

  const restored = after.sections[1].parts.find((r) => r.channel === 9);
  const original = parseCasm(buffer).sections[0].parts.find((r) => r.channel === 9);
  assert.equal(restored.name, original.name);
  assert.equal(restored.chordType, 8, 'and its chord type, not a default');
  assert.equal(restored.low.highLimit, original.low.highLimit);
  assert.deepEqual([...restored.reserved], [...original.reserved], 'and the reserved bytes');
});

test('a channel no other section uses cannot be switched on', () => {
  const casm = parseCasm(styleWith([section('Main A', [part(8, 'Rhythm1')])]));
  const result = setSectionChannel(casm, 0, 11, true);
  assert.equal(result.ok, false);
  assert.match(result.reason, /no other variation/);
});

test('switching something already in that state says so', () => {
  const casm = parseCasm(styleWith([section('Main A', [part(8, 'Rhythm1')])]));
  assert.equal(setSectionChannel(casm, 0, 8, true).ok, false);
  assert.equal(setSectionChannel(casm, 0, 9, false).ok, false);
  assert.equal(setSectionChannel(casm, 5, 8, true).ok, false, 'no such section');
});

test('a documented field can be edited and written', () => {
  const buffer = styleWith([section('Main A', [part(9, 'Drums')])]);
  const casm = parseCasm(buffer);
  const applied = applyCasmOperations(casm, [
    { op: 'field', section: 'Main A', channel: 9, field: 'editable', value: true },
    { op: 'field', section: 'Main A', channel: 9, field: 'chordType', value: 14 },
    { op: 'field', section: 'Main A', channel: 9, field: 'chordKey', value: 5 },
    { op: 'field', section: 'Main A', channel: 9, field: 'destinationChannel', value: 12 },
    { op: 'field', section: 'Main A', channel: 9, field: 'low', value: { lowLimit: 36, highLimit: 60, retrigger: 3 } },
  ]);
  assert.equal(applied.ok, true, applied.reason ?? '');

  const after = parseCasm(writeCasm(buffer, casm));
  const p = after.sections[0].parts[0];
  assert.equal(p.editable, true);
  assert.equal(p.chordType, 14);
  assert.equal(p.chordTypeName, CHORD_TYPES[14]);
  assert.equal(p.chordKey, 5);
  assert.equal(p.chordKeyName, 'F');
  assert.equal(p.destinationChannel, 12);
  assert.equal(p.low.lowLimit, 36);
  assert.equal(p.low.highLimit, 60);
  assert.equal(p.low.retrigger, 3);
  // Everything else must be untouched.
  assert.equal(p.name, 'Drums');
  assert.equal(p.middleHigh, 127);
  assert.equal(p.high.retrigger, 0);
});

test('an out-of-range field value is clamped rather than written raw', () => {
  const buffer = styleWith([section('Main A', [part(9, 'Drums')])]);
  const casm = parseCasm(buffer);
  applyCasmOperations(casm, [
    { op: 'field', section: 'Main A', channel: 9, field: 'chordType', value: 999 },
    { op: 'field', section: 'Main A', channel: 9, field: 'low', value: { lowLimit: -5, highLimit: 999 } },
  ]);
  const p = parseCasm(writeCasm(buffer, casm)).sections[0].parts[0];
  assert.equal(p.chordType, CHORD_TYPES.length - 1);
  assert.equal(p.low.lowLimit, 0);
  assert.equal(p.low.highLimit, 127);
});

test('editing a field on a part the section does not use says so', () => {
  const casm = parseCasm(styleWith([section('Main A', [part(9, 'Drums')])]));
  const result = applyCasmOperations(casm, [
    { op: 'field', section: 'Main A', channel: 12, field: 'chordType', value: 2 },
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.applied, 0);
});

test('renaming a variation keeps everything else byte-identical', () => {
  const buffer = styleWith([
    section('Main A', [part(8, 'Rhythm1')]),
    section('Main B', [part(8, 'Rhythm1'), part(9, 'Rhythm2')]),
  ]);
  const casm = parseCasm(buffer);
  const otherBefore = [...parseCasm(buffer).sections[1].nameBytes];
  assert.equal(renameSection(casm, 0, 'Layla').ok, true);

  const out = writeCasm(buffer, casm);
  const after = parseCasm(out);
  assert.equal(after.sections[0].name, 'Layla');
  assert.deepEqual([...after.sections[1].nameBytes], otherBefore);
  assert.deepEqual(after.sections[1].channels, [8, 9]);
  assert.equal(out.byteLength, buffer.byteLength + ('Layla'.length - 'Main A'.length));
});

test('deleting a variation removes its whole group', () => {
  const buffer = styleWith([
    section('Main A', [part(8, 'Rhythm1')]),
    section('Fill In AA', [part(8, 'Rhythm1'), part(9, 'Rhythm2')]),
    section('Main B', [part(8, 'Rhythm1')]),
  ]);
  const casm = parseCasm(buffer);
  assert.equal(removeSection(casm, 1).ok, true);
  const after = parseCasm(writeCasm(buffer, casm));
  assert.deepEqual(after.sections.map((s) => s.name), ['Main A', 'Main B']);
  assert.deepEqual(casm.sections.map((s) => s.index), [0, 1]);
});

test('a new variation is a copy, so it arrives playable', () => {
  const buffer = styleWith([section('Main A', [part(8, 'Rhythm1'), part(10, 'Bass')])]);
  const casm = parseCasm(buffer);
  const result = cloneSection(casm, 0);
  assert.equal(result.ok, true);
  assert.equal(result.name, 'Main B');

  const after = parseCasm(writeCasm(buffer, casm));
  assert.deepEqual(after.sections.map((s) => s.name), ['Main A', 'Main B']);
  assert.deepEqual(after.sections[1].channels, [8, 10]);
  assert.equal(after.sections[1].parts[1].chordType, after.sections[0].parts[1].chordType,
    'voice settings came along');
});

test('a cloned name skips letters already taken', () => {
  const casm = parseCasm(styleWith([
    section('Main A', [part(8, 'Rhythm1')]),
    section('Main C', [part(8, 'Rhythm1')]),
  ]));
  assert.equal(cloneSection(casm, 1).name, 'Main D');
});

test('the notes are never touched by a map edit', () => {
  const noteTrack = chunk('MTrk', Uint8Array.from([
    0x00, 0xff, 0x2f, 0x00,
    0x00, 0x99, 36, 100, 0x60, 0x89, 36, 0,
    0x00, 0x99, 42, 70, 0x60, 0x89, 42, 0,
  ]));
  const head = chunk('MThd', Uint8Array.from([0, 1, 0, 1, 0x01, 0xe0]));
  const buffer = toBuf(new Uint8Array([
    ...head, ...noteTrack,
    ...chunk('CASM', section('Main A', [part(8, 'Rhythm1'), part(9, 'Rhythm2')])),
  ]));

  const casm = parseCasm(buffer);
  setSectionChannel(casm, 0, 9, false);
  const out = new Uint8Array(writeCasm(buffer, casm));

  const trackStart = head.length + 8;
  const trackBefore = new Uint8Array(buffer, trackStart, noteTrack.length - 8);
  const trackAfter = out.slice(trackStart, trackStart + noteTrack.length - 8);
  assert.deepEqual([...trackAfter], [...trackBefore], 'the MTrk is byte-identical');
  assert.equal(out[0], 0x4d, 'still opens with MThd');
});

// ---- replaying --------------------------------------------------------------

test('operations are replayed onto a fresh parse, in order', () => {
  const buffer = styleWith([
    section('Main A', [part(8, 'Rhythm1')]),
    section('Main B', [part(8, 'Rhythm1')]),
  ]);
  const operations = [
    { op: 'field', section: 'Main A', channel: 8, field: 'chordType', value: 19 },
    { op: 'clone', after: 'Main A', name: 'Main E' },
    { op: 'field', section: 'Main E', channel: 8, field: 'editable', value: true },
  ];
  const { casm, applied } = casmWithEdits(buffer, operations);
  assert.equal(applied, 3);
  assert.deepEqual(casm.sections.map((s) => s.name), ['Main A', 'Main E', 'Main B']);
  assert.equal(casm.sections[0].parts[0].chordType, 19);
  assert.equal(casm.sections[1].parts[0].editable, true);
});

test('replaying an empty list restores the original exactly', () => {
  const buffer = styleWith([section('Main A', [part(8, 'Rhythm1')])]);
  const staged = parseCasm(buffer);
  applyCasmOperations(staged, [
    { op: 'field', section: 'Main A', channel: 8, field: 'chordType', value: 30 },
  ]);
  const stagedBytes = new Uint8Array(writeCasm(buffer, staged));
  assert.notDeepEqual([...stagedBytes], [...new Uint8Array(buffer)], 'the edit changed something');

  const restored = casmWithEdits(buffer, []);
  assert.deepEqual([...new Uint8Array(writeCasm(buffer, restored.casm))], [...new Uint8Array(buffer)]);
});

test('a field write to a renamed section resolves by name, not index', () => {
  // Operations name sections, so a rename followed by an edit to the new name
  // works even though the rename moved nothing but the text.
  const buffer = styleWith([
    section('Main A', [part(8, 'Rhythm1')]),
    section('Main B', [part(8, 'Rhythm1')]),
  ]);
  const { casm } = casmWithEdits(buffer, [
    { op: 'rename', section: 'Main B', name: 'Main E' },
    { op: 'field', section: 'Main E', channel: 8, field: 'chordType', value: 8 },
  ]);
  assert.equal(casm.sections[1].name, 'Main E');
  assert.equal(casm.sections[1].parts[0].chordType, 8);
  assert.equal(casm.sections[0].parts[0].chordType, 0, 'and not the other one');
});

test('styleParts reports a channel that changes name between variations', () => {
  const buffer = styleWith([
    section('Main A', [part(13, 'Clavi')]),
    section('Ending A', [part(13, 'Pad')]),
  ]);
  const parts = styleParts(parseCasm(buffer));
  const clavi = parts.find((p) => p.channel === 13);
  assert.deepEqual(clavi.names.sort(), ['Clavi', 'Pad']);
  assert.equal(clavi.sections, 2);
});