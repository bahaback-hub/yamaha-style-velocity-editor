/**
 * Cross-checking the two halves of a style against each other.
 *
 * A Yamaha style records its variations twice, independently:
 *
 *   - CASM says which parts *may* sound in each variation;
 *   - MIDI marker events in the performance say where each variation *starts*.
 *
 * Reading only one of them gives half the picture, which is how this tool ended up
 * claiming that variations could not be told apart in time when they can. Reading
 * both gives something better than either: they can be checked against each other.
 *
 * If the marker for Main D is followed by exactly the channels CASM lists for Main D,
 * then two independent parts of the file agree, and the mapping is almost certainly
 * right. A disagreement means one of the two readers is wrong - which is exactly
 * the kind of quiet error that would otherwise only show up on the instrument.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { indexNotes } from '../src/smf.js';
import { parseCasm } from '../src/cseg.js';

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

/** Channels sounding between two ticks. */
function channelsBetween(notes, from, to) {
  return [...new Set(notes.filter((n) => n.at >= from && n.at < to).map((n) => n.channel))]
    .sort((a, b) => a - b);
}

/** Read a style's two descriptions at once. */
function describe(path) {
  const buffer = toBuf(readFileSync(path));
  const parsed = indexNotes(buffer, 0, buffer.byteLength);
  return { casm: parseCasm(buffer), parsed };
}

// ---- the collection -----------------------------------------------------------

test('every style in the collection carries variation markers', { skip: !hasCollection }, () => {
  const missing = [];
  for (const path of files) {
    const { parsed } = describe(path);
    if (!parsed.markers.length) missing.push(path);
  }
  assert.deepEqual(missing, [], 'a style with no markers has no recorded variation boundaries');
  console.log(`      ${files.length} styles, all with markers`);
});

test('the markers and the declared map agree, span by span', { skip: !hasCollection }, () => {
  const mismatches = [];
  let compared = 0;
  let stylesFullyMatching = 0;

  for (const path of files) {
    const { casm, parsed } = describe(path);
    if (!casm) continue;

    const declared = new Map(casm.sections.map((s) => [s.name, s.channels]));
    const perStyle = [];
    for (const span of parsed.sectionSpans) {
      const want = declared.get(span.name);
      // A marker naming something CASM does not declare - "SInt", or a variation
      // the style declares but never played - is not a disagreement.
      if (!want) continue;
      const got = channelsBetween(parsed.notes, span.startTick, span.endTick);
      compared++;
      // A variation that was declared but left silent on this pass is not a
      // contradiction: the arranger records what sounded, not what could sound.
      if (got.length === 0) { perStyle.push({ span, got, want, skip: true }); continue; }
      // Extra channels are allowed: a release from the previous variation overlaps
      // the marker. What must not be missing is a channel the map promises.
      const missing = want.filter((c) => !got.includes(c));
      if (missing.length) {
        perStyle.push({ span, got, want, missing });
        mismatches.push(`${path}: ${span.name} is missing channel(s) ${missing.join(',')}`
          + ` - declared ${want.join(',')}, sounded ${got.join(',')}`);
      }
    }
    const bad = perStyle.filter((p) => p.missing);
    if (bad.length === 0) stylesFullyMatching++;
  }

  console.log(`      compared ${compared} spans; ${stylesFullyMatching}/${files.length} styles fully consistent`);
  assert.deepEqual(mismatches, [],
    'every channel a variation declares must sound during that variation');
});

test('each style plays its variations in the order it recorded them', { skip: !hasCollection }, () => {
  // Not the canonical order - the order the style was played in. Worth asserting so
  // that a change in how spans are built cannot quietly reorder anything.
  const raw = readFileSync(join(COLLECTION, 'ROMBA 149.S379.STY'));
  const { parsed } = describe(join(COLLECTION, 'ROMBA 149.S379.STY'));
  assert.ok(parsed, 'the reference style parses');
  assert.ok(raw.length > 0);
  const names = parsed.sectionSpans.map((s) => s.name);
  assert.equal(names[0], 'SInt', 'the style opens with its setup bar');
  assert.deepEqual(names.slice(1, 4), ['Main B', 'Main C', 'Main D'],
    'and then the variations in the order they were recorded, not A B C D');
});

test('spans cover the performance without gaps or overlaps', { skip: !hasCollection }, () => {
  for (const path of files) {
    const { parsed } = describe(path);
    if (!parsed.sectionSpans.length) continue;
    for (let i = 1; i < parsed.sectionSpans.length; i++) {
      assert.equal(parsed.sectionSpans[i].startTick, parsed.sectionSpans[i - 1].endTick,
        `${path}: span ${i} must begin where the previous ended`);
    }
    assert.ok(parsed.sectionSpans[0].startTick === 0, `${path}: the performance starts at tick 0`);
    assert.ok(parsed.sectionSpans[parsed.sectionSpans.length - 1].endTick > 0,
      `${path}: the last span has a length`);
  }
});

test('every note falls inside exactly one span', { skip: !hasCollection }, () => {
  for (const path of files) {
    const { parsed } = describe(path);
    if (!parsed.sectionSpans.length) continue;
    let orphaned = 0;
    for (const note of parsed.notes) {
      const hits = parsed.sectionSpans.filter((s) => note.at >= s.startTick && note.at < s.endTick);
      if (hits.length !== 1) orphaned++;
    }
    assert.equal(orphaned, 0, `${path}: every note must belong to one variation`);
  }
});

// ---- synthetic ----------------------------------------------------------------

/** A style with a marker per variation and a matching CASM. */
function styleWith(markersAndNotes) {
  const RECORD = 55;
  const name8 = (s) => Uint8Array.from([...s.padEnd(8, ' ')].map((c) => c.charCodeAt(0)));
  const voiceRecord = (channel, name) => {
    const out = new Uint8Array(RECORD);
    out.set([...'Ctb2'].map((c) => c.charCodeAt(0)), 0);
    out[7] = 47;                     // the Int32 length, low byte
    out[8] = channel;                // source channel
    out.set(name8(name), 9);
    out[17] = channel;
    out[18] = 0x0f;
    return out;
  };
  const cseg = (sectionName, channels) => {
    const text = Uint8Array.from([...sectionName].map((c) => c.charCodeAt(0)));
    const records = channels.map(([ch, nm]) => voiceRecord(ch, nm));
    const body = new Uint8Array(8 + text.length + records.length * RECORD);
    body.set([...'Sdec'].map((c) => c.charCodeAt(0)), 0);
    new DataView(body.buffer).setUint32(4, text.length);
    body.set(text, 8);
    let p = 8 + text.length;
    for (const r of records) { body.set(r, p); p += RECORD; }
    const chunkOut = new Uint8Array(8 + body.length);
    chunkOut.set([...'CSEG'].map((c) => c.charCodeAt(0)), 0);
    new DataView(chunkOut.buffer).setUint32(4, body.length);
    chunkOut.set(body, 8);
    return chunkOut;
  };
  const chunk = (id, payload) => {
    const out = new Uint8Array(8 + payload.length);
    out.set([...id].map((c) => c.charCodeAt(0)), 0);
    new DataView(out.buffer).setUint32(4, payload.length);
    out.set(payload, 8);
    return out;
  };
  const marker = (name) => [0xff, 0x06, name.length, ...[...name].map((c) => c.charCodeAt(0))];

  const events = [0x00, 0xff, 0x58, 0x04, 0x04, 0x02, 0x18, 0x08];
  let t = 0;
  for (const m of markersAndNotes) {
    events.push(...varLen(t), ...marker(m.name));
    for (const [ch, pitch, vel] of m.notes) {
      events.push(...varLen(0), 0x90 | ch, pitch, vel, ...varLen(480), 0x80 | ch, pitch, 0);
      t += 480;
    }
  }
  events.push(...varLen(0), 0xff, 0x2f, 0x00);

  const trackLen = events.length;
  const track = Uint8Array.from([
    0x4d, 0x54, 0x72, 0x6b,
    (trackLen >>> 24) & 0xff, (trackLen >>> 16) & 0xff, (trackLen >>> 8) & 0xff, trackLen & 0xff,
    ...events,
  ]);
  const head = chunk('MThd', Uint8Array.from([0, 1, 0, 1, 0x01, 0xe0]));
  const csegs = markersAndNotes.map((m) => cseg(m.name, m.channels));
  const body = new Uint8Array(csegs.reduce((a, c) => a + c.length, 0));
  let p = 0; for (const c of csegs) { body.set(c, p); p += c.length; }
  const all = new Uint8Array([...head, ...track, ...chunk('CASM', body)]);
  return all.buffer.slice(all.byteOffset, all.byteOffset + all.byteLength);
}

/** The canonical variable-length encoding. */
function varLen(value) {
  const out = [value & 0x7f];
  let v = value >> 7;
  while (v > 0) { out.push((v & 0x7f) | 0x80); v >>= 7; }
  return out.reverse();
}

test('a marker splits the performance into variations', () => {
  const buffer = styleWith([
    { name: 'Main A', channels: [[9, 'Drums']], notes: [[9, 36, 100], [9, 42, 70]] },
    { name: 'Intro A', channels: [[11, 'Bass']], notes: [[11, 40, 80]] },
    { name: 'Ending A', channels: [[9, 'Drums']], notes: [[9, 36, 90], [9, 42, 60]] },
  ]);
  const parsed = indexNotes(buffer, 0, buffer.byteLength);
  assert.equal(parsed.markers.length, 3);
  assert.deepEqual(parsed.markers.map((m) => m.name), ['Main A', 'Intro A', 'Ending A']);
  assert.deepEqual(parsed.sectionSpans.map((s) => s.name), ['Main A', 'Intro A', 'Ending A']);
  assert.deepEqual(parsed.sectionSpans.map((s) => s.at ?? s.startTick),
    parsed.sectionSpans.map((s) => s.startTick));

  // Each span really does hold only its own notes.
  const drumsIn = (name) => parsed.notes
    .filter((n) => {
      const s = parsed.sectionSpans.find((x) => x.name === name);
      return n.at >= s.startTick && n.at < s.endTick;
    })
    .map((n) => n.channel);
  assert.deepEqual([...new Set(drumsIn('Main A'))], [9]);
  assert.deepEqual([...new Set(drumsIn('Intro A'))], [11]);
});

test('a variation declared but never played is still found', () => {
  const buffer = styleWith([
    { name: 'Main A', channels: [[9, 'Drums']], notes: [[9, 36, 100]] },
    { name: 'Fill In AA', channels: [[9, 'Drums']], notes: [] },
    { name: 'Main B', channels: [[9, 'Drums']], notes: [[9, 36, 100]] },
  ]);
  const parsed = indexNotes(buffer, 0, buffer.byteLength);
  assert.equal(parsed.sectionSpans.length, 3);
  const fill = parsed.sectionSpans[1];
  assert.equal(fill.name, 'Fill In AA');
  assert.ok(fill.endTick > fill.startTick, 'a silent variation still has a length');
  assert.equal(parsed.notes.filter((n) => n.at >= fill.startTick && n.at < fill.endTick).length, 0);
});

test('a style with no markers is one span, not a failure', () => {
  const events = [
    0x00, 0xff, 0x58, 0x04, 0x04, 0x02, 0x18, 0x08,
    0x00, 0x99, 36, 100, 0x60, 0x89, 36, 0,
    0x00, 0xff, 0x2f, 0x00,
  ];
  const all = Uint8Array.from([
    0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, 0, 1, 0x01, 0xe0,
    0x4d, 0x54, 0x72, 0x6b,
    (events.length >>> 24) & 0xff, (events.length >>> 16) & 0xff,
    (events.length >>> 8) & 0xff, events.length & 0xff,
    ...events,
  ]);
  const buffer = all.buffer.slice(all.byteOffset, all.byteOffset + all.byteLength);
  const parsed = indexNotes(buffer, 0, buffer.byteLength);
  assert.deepEqual(parsed.markers, []);
  assert.equal(parsed.sectionSpans.length, 1);
  assert.equal(parsed.sectionSpans[0].name, 'Performance');
});

test('a marker with padding still yields the plain name', () => {
  // A writer that pads the name to a fixed width, which the length field then
  // covers. The name has to come back without the padding.
  const name = 'Main A';
  const padded = name + '    ';
  const events = [
    0x00, 0xff, 0x06, padded.length, ...[...padded].map((c) => c.charCodeAt(0)),
    0x00, 0x99, 36, 100, 0x60, 0x89, 36, 0,
    0x00, 0xff, 0x2f, 0x00,
  ];
  const all = Uint8Array.from([
    0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, 0, 1, 0x01, 0xe0,
    0x4d, 0x54, 0x72, 0x6b,
    (events.length >>> 24) & 0xff, (events.length >>> 16) & 0xff,
    (events.length >>> 8) & 0xff, events.length & 0xff,
    ...events,
  ]);
  const buffer = all.buffer.slice(all.byteOffset, all.byteOffset + all.byteLength);
  const parsed = indexNotes(buffer, 0, buffer.byteLength);
  assert.equal(parsed.markers[0].name, 'Main A', 'the padding is not part of the name');
  assert.equal(parsed.sectionSpans[0].name, 'Main A');
});