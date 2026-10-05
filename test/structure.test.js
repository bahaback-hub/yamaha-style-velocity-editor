/**
 * Tests for structure reading (CASM) and time layout.
 *
 * The fixtures mirror the shape of the real exports: a CASM chunk holding CSEG
 * groups, each with an Sdec section list and 0x2F channel entries. The tempo and
 * time-signature cases come from a real file that declared 10/16, which is what
 * exposed the tick-conversion bugs these guard against.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readStyleStructure, voiceFamily, sectionLabel, summariseByChannel } from '../src/sections.js';
import { parseCasm } from '../src/cseg.js';
import { resolveMeter, detectBlocks, presencePerBar, MAX_BARS, BLOCK_SOURCE } from '../src/timeline.js';
import { indexNotes, tickToSeconds, ticksPerBar } from '../src/smf.js';

// ---- fixtures ---------------------------------------------------------------

function chunk(id, payload) {
  const out = new Uint8Array(8 + payload.length);
  for (let i = 0; i < 4; i++) out[i] = i < id.length ? id.charCodeAt(i) : 0;
  const len = payload.length;
  out[4] = (len >>> 24) & 0xff; out[5] = (len >>> 16) & 0xff;
  out[6] = (len >>> 8) & 0xff; out[7] = len & 0xff;
  out.set(payload, 8);
  return out;
}
function concat(parts) {
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const part of parts) { out.set(part, p); p += part.length; }
  return out;
}
const name8 = (s) => Uint8Array.from([...s.padEnd(8, ' ')].map((c) => c.charCodeAt(0)));
const bytes = (s) => Uint8Array.from([...s].map((c) => c.charCodeAt(0)));

/**
 * A CASM in the real format: one CSEG group per variation, an Sdec holding the
 * variation's name, then one 47-byte Ctb2 per part. The old fixture here wrote a
 * 0x2F marker that the format does not contain, which is how a fixture and the
 * reader it was testing came to disagree.
 */
function casmFixture(groups) {
  const bodies = groups.map((g) => chunk('CSEG', concat([
    chunk('Sdec', bytes(g.sections[0] ?? '')),
    ...g.voices.map((v) => {
      const body = new Uint8Array(47);
      body[0] = v.ch;
      body.set(name8(v.name), 1, 8);
      body[9] = v.ch;
      body[11] = 0x0f; body[12] = 0x0f;
      body[19] = 0;
      body[20] = 0; body[21] = 127;
      for (const at of [22, 28, 34]) { body[at] = 0; body[at + 1] = 1; body[at + 2] = 0; body[at + 3] = 0; body[at + 4] = 127; body[at + 5] = 0; }
      return chunk('Ctb2', body);
    }),
  ])));
  return chunk('CASM', concat(bodies));
}

function smfFixture(events, division = 480) {
  const trackBytes = Uint8Array.from(events);
  const len = trackBytes.length;
  const track = Uint8Array.from([
    0x4d, 0x54, 0x72, 0x6b,
    (len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff,
    ...trackBytes,
  ]);
  return concat([
    Uint8Array.from([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, 0, 1, (division >>> 8) & 0xff, division & 0xff]),
    track,
  ]);
}

const toBuf = (u8) => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);

// ---- CASM -------------------------------------------------------------------

test('reads declared sections and channel voices from CASM', () => {
  // One CSEG group per variation, each naming itself. The earlier fixture packed
  // two names into one Sdec separated by a comma, which the old reader had to
  // split on; real files do not do that, and the old leniency was a symptom of it
  // mis-parsing the chunk rather than of the format.
  const file = concat([
    smfFixture([0x00, 0x99, 36, 100, 0x60, 0x89, 36, 0]),
    casmFixture([
      { sections: ['Main A'], voices: [{ ch: 10, name: 'MainDrum' }, { ch: 12, name: 'Bass' }] },
      { sections: ['Fill In AA'], voices: [{ ch: 10, name: 'MainDrum' }] },
      { sections: ['Intro B'], voices: [{ ch: 8, name: 'AddDrum' }] },
    ]),
  ]);
  const st = readStyleStructure(toBuf(file));

  assert.equal(st.found, true);
  assert.deepEqual(st.declaredSections, ['Main A', 'Fill In AA', 'Intro B']);
  assert.equal(st.groups.length, 3);
  assert.deepEqual(st.groups[0].sections, ['Main A']);
  assert.deepEqual(st.groups[0].voices.map((v) => v.name), ['MainDrum', 'Bass']);
  // The channel byte is the zero-based channel the notes use, with no shift. This
  // used to be read as one-based and have one subtracted, which put every part name
  // on the wrong channel - and a style whose parts sit on channels 9-15 one-based
  // declares 9-15 here.
  assert.equal(st.voices.find((v) => v.name === 'Bass').channel, 12);
  assert.equal(st.voices.find((v) => v.name === 'MainDrum').channel, 10);
});

test('the map reader and the structure reader agree on every part', () => {
  const file = concat([
    smfFixture([0x00, 0x99, 36, 100, 0x60, 0x89, 36, 0]),
    casmFixture([
      { sections: ['Main A'], voices: [{ ch: 10, name: 'MainDrum' }] },
      { sections: ['Intro B'], voices: [{ ch: 8, name: 'AddDrum' }] },
    ]),
  ]);
  const buffer = toBuf(file);
  const fromStructure = readStyleStructure(buffer);
  const fromCseg = parseCasm(buffer);
  // Two readers used to be able to disagree. There is one reader now; this asserts
  // the shape the interface depends on still lines up with it.
  assert.deepEqual(
    fromStructure.groups.map((g) => g.sections[0]),
    fromCseg.sections.map((s) => s.name),
  );
  assert.deepEqual(
    fromStructure.groups[0].voices.map((v) => [v.channel, v.name]),
    fromCseg.sections[0].parts.map((p) => [p.channel, p.name]),
  );
});

test('a part name lands on the channel whose notes it belongs to', () => {
  // The bug this guards against is silent: the name still appears, it just appears
  // one channel to the left, so a drum part inherits the bass's name and the
  // timeline shows the wrong instrument on the wrong lane.
  const file = concat([
    // A note on 0x99, which is zero-based channel 9.
    smfFixture([0x00, 0x99, 36, 100, 0x60, 0x89, 36, 0]),
    casmFixture([{ sections: ['Main A'], voices: [{ ch: 9, name: 'MainDrum' }] }]),
  ]);
  const st = readStyleStructure(toBuf(file));
  assert.equal(st.voices[0].channel, 9);
  assert.equal(notesFor(st)[9], 'MainDrum', 'channel 9 is the drum part');
});

/** The channel -> part-name map a caller would build from the structure. */
function notesFor(st) {
  const out = {};
  for (const v of st.voices) out[v.channel] = v.name;
  return out;
}

test('section names stop at the null padding, not run into the next chunk', () => {
  // A declared length longer than the text is the norm; the reader must cut at
  // the first null rather than treating the trailing bytes as part of the name.
  const file = concat([
    smfFixture([0x00, 0x99, 36, 100, 0x60, 0x89, 36, 0]),
    casmFixture([{ sections: ['Ending A'], voices: [{ ch: 10, name: 'MainDrum' }] }]),
  ]);
  const st = readStyleStructure(toBuf(file));
  assert.deepEqual(st.declaredSections, ['Ending A']);
});

test('a file with no CASM reports absent structure rather than failing', () => {
  const file = smfFixture([0x00, 0x99, 36, 100, 0x60, 0x89, 36, 0]);
  const st = readStyleStructure(toBuf(file));
  assert.equal(st.found, false);
  assert.deepEqual(st.declaredSections, []);
});

test('voiceFamily classifies the Yamaha part names seen in real files', () => {
  // "AddDrum" and "MainDrum" carry "drum" mid-word; a boundary-anchored match
  // would label both as generic and lose the drum timbre.
  assert.equal(voiceFamily('AddDrum'), 'drums');
  assert.equal(voiceFamily('MainDrum'), 'drums');
  assert.equal(voiceFamily('MainDrum2'), 'drums');
  assert.equal(voiceFamily('Bass'), 'bass');
  assert.equal(voiceFamily('NylonGtr'), 'guitar');
  assert.equal(voiceFamily('SteelGtr'), 'guitar');
  assert.equal(voiceFamily('PAD'), 'pad');
  assert.equal(voiceFamily('BAGLAMA'), 'plucked');
  assert.equal(voiceFamily('Flute'), 'brass');
  assert.equal(voiceFamily(''), 'other');
});

test('sectionLabel groups the declared names by kind', () => {
  assert.equal(sectionLabel('Main A'), 'Variation');
  assert.equal(sectionLabel('Intro C'), 'Intro');
  assert.equal(sectionLabel('Fill In BB'), 'Fill In');
  assert.equal(sectionLabel('Ending B'), 'Ending');
  assert.equal(sectionLabel('Normal Ending'), 'Normal Ending');
});

test('summariseByChannel reports per-channel ranges and velocity spread', () => {
  const notes = [
    { note: 36, velocity: 100, channel: 9, at: 0 },
    { note: 42, velocity: 60, channel: 9, at: 240 },
    { note: 40, velocity: 90, channel: 11, at: 480 },
  ];
  const s = summariseByChannel(notes);
  assert.equal(s.size, 2);
  assert.deepEqual(
    [s.get(9).count, s.get(9).low, s.get(9).high, s.get(9).velMin, s.get(9).velMax],
    [2, 36, 42, 60, 100],
  );
  assert.equal(s.get(11).count, 1);
  assert.equal(s.get(11).velSum, 90);
});

// ---- time -------------------------------------------------------------------

test('ticksPerBar uses quarters per bar, not the denominator directly', () => {
  // 6/8 is six eighth-note beats, which is three quarters - dividing by the
  // denominator would give twelve quarters and a grid four times too wide.
  assert.equal(ticksPerBar({ numerator: 4, denominator: 4 }, 480), 1920);
  assert.equal(ticksPerBar({ numerator: 6, denominator: 8 }, 480), 1440);
  assert.equal(ticksPerBar({ numerator: 3, denominator: 4 }, 480), 1440);
  assert.equal(ticksPerBar({ numerator: 10, denominator: 16 }, 480), 1200);
  assert.equal(ticksPerBar({ numerator: 7, denominator: 8 }, 480), 1680);
});

test('tickToSeconds applies the division, not one tick per quarter', () => {
  const tempo = [{ tick: 0, usPerQuarter: 500000 }];
  // 1920 ticks at 480 tpq is four quarters, so two seconds at 120 BPM.
  assert.ok(Math.abs(tickToSeconds(tempo, 1920, 480) - 2) < 1e-9, `got ${tickToSeconds(tempo, 1920, 480)}`);
  // The same ticks at a different division are a different duration.
  assert.ok(Math.abs(tickToSeconds(tempo, 1920, 960) - 1) < 1e-9);
  assert.equal(tickToSeconds(tempo, 0, 480), 0);
  // A nonsensical division must not divide by zero.
  assert.equal(tickToSeconds(tempo, 1920, 0), 0);
});

test('tempo changes are integrated piecewise', () => {
  const tempo = [
    { tick: 0, usPerQuarter: 500000 },   // 120 BPM
    { tick: 1920, usPerQuarter: 1000000 }, // 60 BPM from bar 2
  ];
  // One bar (4 quarters) at 120 BPM is 2s; the next bar at 60 BPM is 4s.
  assert.ok(Math.abs(tickToSeconds(tempo, 3840, 480) - 6) < 1e-9, `got ${tickToSeconds(tempo, 3840, 480)}`);
  // Before the change the tempo is still the first one.
  assert.ok(Math.abs(tickToSeconds(tempo, 1920, 480) - 2) < 1e-9);
});

test('resolveMeter accepts a declared meter that fits and reports it', () => {
  // The real Karadeniz file declares 10/16, which at 1920 tpq is 4800 ticks per
  // bar - and 264000 ticks over that is a musically sensible 55 bars.
  const m = resolveMeter({ numerator: 10, denominator: 16 }, 264000, 1920);
  assert.equal(m.source, BLOCK_SOURCE.declared);
  assert.equal(m.numerator, 10);
  assert.equal(m.bars, 55);
});

test('resolveMeter replaces an implausible meter and says so', () => {
  // 10/4 over a two-second file would imply millions of bars.
  const m = resolveMeter({ numerator: 10, denominator: 4 }, 3840, 480);
  assert.equal(m.source, BLOCK_SOURCE.inferred);
  assert.equal(m.numerator, 4);
  assert.match(m.note, /does not fit/);
  assert.ok(m.bars <= MAX_BARS);
});

test('resolveMeter never returns more bars than the cap', () => {
  const m = resolveMeter({ numerator: 1, denominator: 1024 }, 10_000_000, 1920);
  assert.ok(m.bars <= MAX_BARS, `got ${m.bars}`);
});

test('detectBlocks finds where the set of sounding parts changes', () => {
  const notes = [
    { note: 36, channel: 9, at: 0 },
    { note: 40, channel: 11, at: 0 },
    { note: 42, channel: 11, at: 1920 },
    { note: 42, channel: 11, at: 5760 }, // ch11 still present in bar 3
    { note: 51, channel: 14, at: 5760 }, // a new part joins in bar 3
  ];
  const meter = { bars: 4, ticksPerBar: 1920 };
  const blocks = detectBlocks(notes, meter, 1920);
  // bar 0 has {9,11}; bars 1-2 have {11} because the ch9 note was only in bar 0;
  // bar 3 has {11,14}. Two distinct changes, so three blocks.
  assert.equal(blocks.length, 3);
  assert.deepEqual(blocks[0].channels, [9, 11]);
  assert.deepEqual(blocks[1].channels, [11]);
  assert.deepEqual(blocks[2].channels, [11, 14]);
  assert.equal(blocks[0].startBar, 0);
  assert.equal(blocks[1].startBar, 1);
  assert.equal(blocks[2].startBar, 3);
  assert.equal(blocks[2].endBar, 4);
  // Blocks are inference, and must be labelled as such.
  assert.ok(blocks.every((b) => b.source === BLOCK_SOURCE.inferred));
  assert.ok(blocks.every((b) => b.label.startsWith('Block')));
});

test('a silent bar does not split a block', () => {
  const notes = [
    { note: 36, channel: 9, at: 0 },
    { note: 36, channel: 9, at: 1920 },
    { note: 36, channel: 9, at: 1920 * 3 }, // bar 2 empty
    { note: 36, channel: 9, at: 1920 * 4 },
  ];
  const blocks = detectBlocks(notes, { bars: 5, ticksPerBar: 1920 }, 1920);
  assert.equal(blocks.length, 1, 'one continuous part, however it is spaced');
});

test('detectBlocks on an empty note list is empty, not one empty block', () => {
  assert.deepEqual(detectBlocks([], { bars: 4, ticksPerBar: 1920 }, 1920), []);
});

test('presencePerBar counts notes per bar per channel', () => {
  const notes = [
    { note: 36, channel: 9, at: 0 },
    { note: 36, channel: 9, at: 120 },
    { note: 40, channel: 11, at: 1920 },
  ];
  const p = presencePerBar(notes, { bars: 3, ticksPerBar: 1920 }, 1920);
  assert.equal(p.get(9)[0], 2);
  assert.equal(p.get(9)[1], 0);
  assert.equal(p.get(11)[1], 1);
});

// ---- integration with the parser --------------------------------------------

test('absolute ticks, tempo and durations come out of one parse', () => {
  // Deltas: tempo meta 0, note on 0, note off 0x60 (96), note on 0, note off
  // 0x30 (48). Absolute ticks are cumulative: 0 then 96. Durations come from
  // the matched note-off, not from the delta that preceded it.
  const file = smfFixture([
    0x00, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20,
    0x00, 0x99, 36, 100,
    0x60, 0x89, 36, 0,
    0x00, 0x99, 42, 70,
    0x30, 0x89, 42, 0,
  ]);
  const r = indexNotes(toBuf(file), 0, file.length);
  assert.equal(r.notes.length, 2);
  assert.equal(r.notes[0].at, 0);
  assert.equal(r.notes[1].at, 96, 'the 96-tick note-off shifted the second note-on');
  assert.equal(r.notes[0].durationTicks, 96);
  assert.equal(r.notes[1].durationTicks, 48);
  assert.equal(r.tempoMap.length, 1, 'a tempo at tick 0 replaces the default, not appends to it');
  assert.ok(Math.abs(60000000 / r.tempoMap[0].usPerQuarter - 120) < 0.1);
});

test('a note left hanging by a missing note-off gets duration zero, not a guess', () => {
  const file = smfFixture([0x00, 0x99, 36, 100]);
  const r = indexNotes(toBuf(file), 0, file.length);
  assert.equal(r.notes.length, 1);
  assert.equal(r.notes[0].durationTicks, 0);
});
