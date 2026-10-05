/**
 * Lifting one note's velocity everywhere - and only where it should.
 *
 * This has its own fixture because the editor fixture's notes are all distinct, and
 * "every occurrence" needs a note that actually repeats. Loosening the shared
 * fixture's note counts to get one would only move the problem somewhere else.
 *
 * The style below is two marked variations over two bars of 4/4. The kick plays
 * twice in Main A and twice in Main B, at two different velocities, so the two
 * scopes the control offers - the whole style, and one variation - have visibly
 * different answers and a mistake in either is impossible to miss.
 */

import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT = 'C:/Users/DSER/AppData/Local/Temp/opencode/sty-e2e-lift';
mkdirSync(OUT, { recursive: true });
const BASE = `http://localhost:${process.env.PORT ?? '5173'}/`;

// ---- fixture ----------------------------------------------------------------

function concat(parts) {
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const part of parts) { out.set(part, p); p += part.length; }
  return out;
}
function chunk(id, payload) {
  const out = new Uint8Array(8 + payload.length);
  for (let i = 0; i < 4; i++) out[i] = i < id.length ? id.charCodeAt(i) : 0;
  const len = payload.length;
  out[4] = (len >>> 24) & 0xff; out[5] = (len >>> 16) & 0xff;
  out[6] = (len >>> 8) & 0xff; out[7] = len & 0xff;
  out.set(payload, 8);
  return out;
}
function track(events) {
  return chunk('MTrk', Uint8Array.from([...events, 0x00, 0xff, 0x2f, 0x00]));
}
function mthd(division, nTracks) {
  return chunk('MThd', Uint8Array.from([
    0, 1, (nTracks >>> 8) & 0xff, nTracks & 0xff,
    (division >>> 8) & 0xff, division & 0xff,
  ]));
}
/** A variable-length quantity, so a gap of any length is written correctly. */
function ticks(n) {
  const out = [n & 0x7f];
  n >>= 7;
  while (n > 0) { out.unshift((n & 0x7f) | 0x80); n >>= 7; }
  return out;
}
const name8 = (s) => Uint8Array.from([...s.padEnd(8, ' ')].map((c) => c.charCodeAt(0)));
// A delta is followed by its own event, so the gap belongs to the marker. Two
// deltas in a row is not valid MIDI and a reader takes the second for a status byte.
const markerAt = (gap, name) => [
  ...ticks(gap), 0xff, 0x06, name.length, ...[...name].map((c) => c.charCodeAt(0)),
];

const BEAT = 480; // 4/4 at 480 ticks a beat
const BAR = BEAT * 4; // so a bar is 1920 ticks, and two bars make the two variations
const HALF = BEAT / 2;
// Events are written by absolute tick, with the gap worked out here rather than
// by hand: a delta is the distance from the previous event, and getting that
// wrong produces a file that parses into nonsense.
function writeEvents(hits, pitch) {
  const out = [];
  let cursor = 0;
  for (const { at, velocity } of hits) {
    out.push(...ticks(at - cursor), 0x99, pitch, velocity, ...ticks(HALF), 0x89, pitch, 0);
    cursor = at + HALF;
  }
  return out;
}

const KICK = 36;
const CYMBAL = 42;

// The kick on every beat: four in Main A, four in Main B, and quieter in the second
// - the situation the control exists for. The cymbal is there so the part holds
// more than one note, and lifting must leave it alone.
const bar = (start, velocity) => [0, 1, 2, 3].map((b) => ({ at: start + b * BEAT, velocity }));
const kicks = [...bar(0, 100), ...bar(BAR, 60)];
const offbeats = (start) => [0.5, 1.5, 2.5, 3.5].map((b) => ({ at: start + b * BEAT, velocity: 80 }));
const cymbals = [...offbeats(0), ...offbeats(BAR)];

const smf = concat([
  mthd(BEAT, 2),
  track([
    0x00, 0xff, 0x58, 0x04, 0x04, 0x02, 0x18, 0x08,
    0x00, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20,
    ...markerAt(0, 'Main A'),
    ...markerAt(BAR, 'Main B'),
  ]),
  track([...writeEvents(kicks, KICK), ...writeEvents(cymbals, CYMBAL)]),
]);

// CASM declaring both variations with the drum part, so the markers and the map
// agree and the scoped lift has something real to scope against.
function voiceRecord(channel, name) {
  const out = new Uint8Array(55);
  out.set([...'Ctb2'].map((c) => c.charCodeAt(0)), 0);
  out[7] = 0x2f;
  out[8] = channel;
  out.set(name8(name), 9);
  out.fill(0, 17);
  out[17] = channel;
  out[18] = 0x0f;
  out[19] = 0xff;
  return out;
}
function cseg(sectionName, records) {
  const text = Uint8Array.from([...sectionName].map((c) => c.charCodeAt(0)));
  const body = new Uint8Array(8 + text.length + records.length * 55);
  body[0] = 0x53; body[1] = 0x64; body[2] = 0x65; body[3] = 0x63; // "Sdec"
  new DataView(body.buffer).setUint32(4, text.length);
  body.set(text, 8);
  let p = 8 + text.length;
  for (const r of records) { body.set(r, p); p += 55; }
  return chunk('CSEG', body);
}
const DRUM = 9; // channel 9, zero-based
const casm = chunk('CASM', concat([
  cseg('Main A', [voiceRecord(DRUM, 'Drums')]),
  cseg('Main B', [voiceRecord(DRUM, 'Drums')]),
]));

const styPath = join(OUT, 'lift.sty');
writeFileSync(styPath, concat([smf, casm]));
const originalBytes = readFileSync(styPath);

const { findMidiPayloads } = await import('../src/sff.js');
const { indexNotes } = await import('../src/smf.js');
const toBuf = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);

/** Every note in the file, as the parser sees it. */
function notesIn(bytes) {
  const buf = toBuf(bytes);
  const p = findMidiPayloads(buf).payloads[0];
  return indexNotes(buf, p.offset, p.size).notes;
}
const kicksIn = (bytes) => notesIn(bytes).filter((n) => n.note === KICK);

const originalKicks = kicksIn(originalBytes);
const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

check('the fixture really repeats the kick', originalKicks.length === 8,
  `${originalKicks.length} kicks`);
check('and plays the two variations at two different volumes',
  new Set(originalKicks.map((n) => n.velocity)).size === 2,
  originalKicks.map((n) => n.velocity).join(','));

// ---- the control ------------------------------------------------------------

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message.slice(0, 140)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 140)); });

await page.goto(BASE, { waitUntil: 'load' });
await page.setInputFiles('#file', styPath);
await page.waitForSelector('#liftNote', { timeout: 30000 });

const summary = async () => (await page.locator('#liftSummary').textContent()).replace(/\s+/g, ' ');

/**
 * Start again from the file as it was.
 *
 * Only clicks when there is something to discard: downloading already clears the
 * staged edits, so the button is disabled by then and a blind click just waits for
 * a control that will never become clickable.
 */
async function reset() {
  if (await page.locator('#btnRevert').isEnabled()) {
    await page.click('#btnRevert');
    await page.waitForTimeout(150);
  }
  await page.selectOption('#liftScope', 'all');
}

check('the scope is the whole style or one variation',
  (await page.locator('#liftScope option').allTextContents()).length === 2,
  (await page.locator('#liftScope option').allTextContents()).join(' | '));
check('the kick is the note offered first', (await page.locator('#liftNote').inputValue()) === String(KICK),
  await page.locator('#liftNote').inputValue());

const whole = await summary();
check('the summary counts all eight kicks, over both bars',
  whole.startsWith('8 occurrences across 2 bars'), whole);

const step = Number(await page.locator('#liftValue').inputValue());
check('the step starts small enough to be a nudge', step > 0 && step <= 20, String(step));

// One press of Louder, then check the file rather than the page.
await page.click('[data-lift="up"]');
await page.waitForTimeout(250);
const louder = await summary();
// The summary prints the range lowest first, so 70-110 and not 110-70.
check('every occurrence moved by exactly the step',
  louder.includes(`velocity now ${60 + step}–${100 + step}`), louder);

const [dlAll] = await Promise.all([page.waitForEvent('download'), page.click('#btnDownload')]);
const allPath = join(OUT, 'lift-all.sty');
await dlAll.saveAs(allPath);
const allBytes = readFileSync(allPath);

check('a lift does not resize the file', allBytes.length === originalBytes.length,
  `${originalBytes.length} vs ${allBytes.length}`);
const allKicks = kicksIn(allBytes);
check('all eight kicks were written at their new values',
  allKicks.length === 8
  && allKicks.filter((n) => n.at < BAR).every((n) => n.velocity === 100 + step)
  && allKicks.filter((n) => n.at >= BAR).every((n) => n.velocity === 60 + step),
  allKicks.map((n) => `${n.at}:${n.velocity}`).join(' '));
const cymbalBefore = notesIn(originalBytes).filter((n) => n.note === 42).map((n) => n.velocity);
const cymbalAfter = notesIn(allBytes).filter((n) => n.note === 42).map((n) => n.velocity);
check('the other note in the part was left alone',
  cymbalAfter.length === cymbalBefore.length
  && cymbalAfter.every((v, i) => v === cymbalBefore[i]),
  `${cymbalBefore.join(',')} vs ${cymbalAfter.join(',')}`);

// The same gesture, scoped to Main B only.
await reset();
await page.selectOption('#liftScope', 'variation');
await page.locator('.var-row').nth(1).locator('.var-name').click();
await page.waitForTimeout(300);

const scoped = await summary();
check('choosing a variation narrows it to that variation',
  scoped.startsWith('4 occurrences across 1 bar'), scoped);

await page.click('[data-lift="up"]');
await page.waitForTimeout(250);
const [dlOne] = await Promise.all([page.waitForEvent('download'), page.click('#btnDownload')]);
const onePath = join(OUT, 'lift-one.sty');
await dlOne.saveAs(onePath);
const oneBytes = readFileSync(onePath);

const oneKicks = kicksIn(oneBytes);
check('Main B moved and Main A did not',
  oneKicks.length === 8
  && oneKicks.filter((n) => n.at < BAR).every((n) => n.velocity === 100)
  && oneKicks.filter((n) => n.at >= BAR).every((n) => n.velocity === 60 + step),
  oneKicks.map((n) => `${n.at}:${n.velocity}`).join(' '));
check('scoping did not resize the file either', oneBytes.length === originalBytes.length,
  `${originalBytes.length} vs ${oneBytes.length}`);

// Set to is absolute, which makes it the clearest read on which notes were hit.
await reset();
await page.fill('#liftValue', '101');
await page.locator('#liftValue').press('Enter');
await page.click('[data-lift="set"]');
await page.waitForTimeout(250);
const [dlSet] = await Promise.all([page.waitForEvent('download'), page.click('#btnDownload')]);
const setPath = join(OUT, 'lift-set.sty');
await dlSet.saveAs(setPath);
const setKicks = kicksIn(readFileSync(setPath));
check('Set to puts every occurrence at the value, whatever it was before',
  setKicks.length === 8 && setKicks.every((n) => n.velocity === 101),
  setKicks.map((n) => n.velocity).join(','));

// Louder past the top must stop at 127 rather than wrap or throw.
await reset();
await page.fill('#liftValue', '60');
await page.locator('#liftValue').press('Enter');
await page.click('[data-lift="up"]');
await page.click('[data-lift="up"]');
await page.click('[data-lift="up"]');
await page.waitForTimeout(300);
const [dlMax] = await Promise.all([page.waitForEvent('download'), page.click('#btnDownload')]);
const maxPath = join(OUT, 'lift-max.sty');
await dlMax.saveAs(maxPath);
check('louder than loudest stops at 127',
  kicksIn(readFileSync(maxPath)).every((n) => n.velocity === 127),
  kicksIn(readFileSync(maxPath)).map((n) => n.velocity).join(','));

check('no JS errors', errors.length === 0, errors.slice(0, 3).join(' | '));

await browser.close();
const failed = checks.filter((c) => !c.ok);
console.log(`\n  ${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length) { console.log('  failing:', failed.map((f) => f.name).join('; ')); process.exitCode = 1; }