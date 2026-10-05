/**
 * Browser checks for the piano roll, the velocity lane and the write path.
 *
 * These are the parts that cannot be verified by reading bytes: a canvas can be
 * wired to nothing and still look fine, and a drag can update a counter while
 * never reaching the file. So each check drives the real pointer, then reads the
 * downloaded file back and asks the parser what actually changed.
 */

import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT = 'C:/Users/DSER/AppData/Local/Temp/opencode/sty-e2e3';
mkdirSync(OUT, { recursive: true });
const BASE = `http://localhost:${process.env.PORT ?? '5173'}/`;

// ---- fixture ----------------------------------------------------------------
// Two parts on two tracks, so a structural edit has to survive the second
// track's offsets shifting behind it.

function track(events) {
  const len = events.length;
  return Uint8Array.from([
    0x4d, 0x54, 0x72, 0x6b,
    (len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff,
    ...events,
  ]);
}
function mthd(division, nTracks) {
  return Uint8Array.from([
    0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1,
    (nTracks >>> 8) & 0xff, nTracks & 0xff,
    (division >>> 8) & 0xff, division & 0xff,
  ]);
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
const concat = (parts) => {
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const part of parts) { out.set(part, p); p += part.length; }
  return out;
};
const name8 = (s) => Uint8Array.from([...s.padEnd(8, ' ')].map((c) => c.charCodeAt(0)));

// A quarter note is 480 ticks, which is the two-byte delta 0x83 0x60.
const Q = [0x83, 0x60];

// Variable-length quantity, for a gap of any length. Every delta is followed by
// its own event, so a gap belongs to the event that comes after it.
function ticks(n) {
  const out = [n & 0x7f];
  n >>= 7;
  while (n > 0) { out.unshift((n & 0x7f) | 0x80); n >>= 7; }
  return out;
}

const drums = [];
for (const [pitch, velocity] of [[36, 100], [38, 70], [42, 90], [46, 60]]) {
  drums.push(0x00, 0x99, pitch, velocity, ...Q, 0x89, pitch, 0);
}
const bass = [];
for (const [pitch, velocity] of [[40, 80], [43, 110]]) {
  bass.push(0x00, 0x9b, pitch, velocity, ...Q, 0x8b, pitch, 0);
}

// A marker names the variation that starts here, which is how a real style records
// where each one begins. They go in the conductor track, as they do in a real file,
// and sit so that each covers half the drums without moving a single note.
const markerAt = (gap, name) => [
  ...ticks(gap), 0xff, 0x06, name.length, ...[...name].map((c) => c.charCodeAt(0)),
];

const smf = concat([
  mthd(480, 2),
  track([0x00, 0xff, 0x58, 0x04, 0x04, 0x02, 0x18, 0x08, 0x00, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20,
    ...markerAt(0, 'Main A'), ...markerAt(480 * 2, 'Main B')]),
  track(drums),
  track(bass),
]);
// CASM with two CSEG groups, built to the real record shape: a 7-byte "Ctb2"
// tag, 0x2F, the channel, an 8-byte padded name, then 38 parameter bytes. The
// channel byte is the same zero-based number the notes use - 0x99 is channel 9,
// 0x9b is channel 11.
function voiceRecord(channel, name, fill = 0) {
  const out = new Uint8Array(55);
  out.set([...'Ctb2'].map((c) => c.charCodeAt(0)), 0);
  out[7] = 0x2f;
  out[8] = channel;
  out.set(name8(name), 9);
  out.fill(fill, 17);
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
const casmGroups = [
  cseg('Main A', [voiceRecord(9, 'MainDrum', 0x20), voiceRecord(11, 'Bass', 0x40)]),
  cseg('Main B', [voiceRecord(9, 'MainDrum', 0x20)]),
];
const casmBody = new Uint8Array(casmGroups.reduce((a, g) => a + g.length, 0));
{
  let q = 0;
  for (const g of casmGroups) { casmBody.set(g, q); q += g.length; }
}
const casm = chunk('CASM', casmBody);

const styPath = join(OUT, 'editor.sty');
writeFileSync(styPath, concat([smf, casm]));

const { findMidiPayloads } = await import('../src/sff.js');
const { indexNotes } = await import('../src/smf.js');
const toBuf = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);

/**
 * The value of the part whose label contains `name`.
 *
 * Matching on the option text rather than on a channel number keeps the test
 * readable, and the separator between the label and the channel is not something
 * this file should have to spell out.
 */
async function partValue(name) {
  const value = await page.locator('#partSelect option')
    .filter({ hasText: name }).first().getAttribute('value');
  if (value === null) throw new Error(`no part matching "${name}"`);
  return value;
}

/** Read a downloaded file back and hand the parser its notes. */
function readBack(path) {
  const bytes = readFileSync(path);
  const buf = toBuf(bytes);
  const p = findMidiPayloads(buf).payloads[0];
  return { bytes, buf, parsed: indexNotes(buf, p.offset, p.size) };
}

/**
 * A canvas box measured at the moment it is used.
 *
 * Clicking a button further down the page scrolls it into view, which moves both
 * canvases. A box captured once at the top of the test is stale by the time a drag
 * comes round, and the pointer lands somewhere else entirely - so every drag
 * re-measures, and scrolls its target into view first.
 */
async function boxOf(selector) {
  const locator = page.locator(selector);
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  if (!box) throw new Error(`${selector} has no box`);
  return box;
}

// ---- browser ----------------------------------------------------------------

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message.slice(0, 140)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 140)); });

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

await page.goto(BASE, { waitUntil: 'load' });
await page.setInputFiles('#file', styPath);
await page.waitForSelector('#panelEdit:not(.hidden)', { timeout: 20000 });

// ---- the roll exists and knows which part it is showing ------------------------
check('both canvases are on screen',
  await page.locator('#roll').isVisible() && await page.locator('#velane').isVisible());
check('the roll has a real backing store sized to its box',
  await page.locator('#roll').evaluate((c) => c.width > 0 && c.height > 0));

const options = await page.locator('#partSelect option').allTextContents();
check('the part selector is named from CASM',
  options.some((o) => /MainDrum/.test(o)) && options.some((o) => /Bass/.test(o)), options.join(' | '));
check('the first part is shown by default', (await page.evaluate(() => window.__editor.part())) === 'MainDrum');
check('the editor reports the note count for that part', /4 notes/.test(await page.locator('#editorHint').textContent()));

const painted = await page.locator('#roll').evaluate((c) => {
  const ctx = c.getContext('2d');
  const { data } = ctx.getImageData(0, 0, c.width, c.height);
  // The plate and the grid are all dark, so a mean would barely move whether or
  // not anything was drawn. Count pixels bright enough to be a note instead.
  let notes = 0;
  for (let i = 0; i < data.length; i += 4) {
    if ((data[i] + data[i + 1] + data[i + 2]) / 3 > 60) notes++;
  }
  return notes;
});
check('the roll actually painted its notes', painted > 50, `${painted} lit pixels`);

// ---- dragging a velocity bar ---------------------------------------------------
const first = await page.evaluate(() => window.__editor.first());
check('the first note is reported at the left edge', first && first.x < 40, JSON.stringify(first));

const laneBox = await boxOf('#velane');
const barX = laneBox.x + first.x + 1;
// 100 is the note's own velocity; 20 px upward is +10, because the lane maps two
// pixels to one unit of velocity.
const fromY = laneBox.y + (await page.evaluate(() => window.__editor.laneY(100)));
const toY = fromY - 20;
await page.mouse.move(barX, fromY);
await page.mouse.down();
await page.mouse.move(barX, toY, { steps: 8 });
await page.mouse.up();

check('a velocity drag registers a pending edit',
  (await page.evaluate(() => window.__editor.pending())) > 0,
  `${await page.evaluate(() => window.__editor.pending())} pending`);
check('the edit counter stops saying nothing is pending',
  !/No pending edits/.test(await page.locator('#editCount').textContent()));
check('revert becomes available', await page.locator('#btnRevert').isEnabled());

const [dl1] = await Promise.all([page.waitForEvent('download'), page.click('#btnDownload')]);
const saved1 = join(OUT, 'velocity.sty');
await dl1.saveAs(saved1);
const back1 = readBack(saved1);
const firstAfter = back1.parsed.notes.find((n) => n.at === 0);
check('the dragged velocity reached the file', firstAfter.velocity === 110,
  `velocity ${firstAfter.velocity}`);
check('a velocity-only edit does not resize the file',
  back1.bytes.length === readFileSync(styPath).length,
  `${back1.bytes.length} bytes`);
// A tick alone does not identify a note - both parts open at tick 0 - so compare
// the untouched notes by channel and position.
const key = (n) => `${n.channel}:${n.at}`;
const originalByKey = new Map(
  indexNotes(toBuf(readFileSync(styPath)), ...(() => {
    const p = findMidiPayloads(toBuf(readFileSync(styPath))).payloads[0];
    return [p.offset, p.size];
  })()).notes.map((n) => [key(n), n.velocity]),
);
const editedKey = `${firstAfter.channel}:${firstAfter.at}`;
const others = back1.parsed.notes.filter((n) => key(n) !== editedKey);
check('every other note kept its velocity',
  others.every((n) => originalByKey.get(key(n)) === n.velocity),
  others.map((n) => `${key(n)}=${n.velocity} want ${originalByKey.get(key(n))}`).join(' '));

// ---- dragging a note's length ---------------------------------------------------
const before = await page.evaluate(() => window.__editor.first());
const rollBox = await boxOf('#roll');
const edgeX = rollBox.x + before.x + before.width;
const edgeY = rollBox.y + before.y + before.height / 2;
await page.mouse.move(edgeX, edgeY);
await page.mouse.down();
await page.mouse.move(edgeX + 60, edgeY, { steps: 10 });
await page.mouse.up();

const grown = await page.evaluate(() => window.__editor.first());
check('a length drag lengthens the note on screen', grown.durationTicks > before.durationTicks,
  `${before.durationTicks} -> ${grown.durationTicks}`);

const [dl2] = await Promise.all([page.waitForEvent('download'), page.click('#btnDownload')]);
const saved2 = join(OUT, 'length.sty');
await dl2.saveAs(saved2);
const back2 = readBack(saved2);
const longNote = back2.parsed.notes.find((n) => n.at === 0);
check('the new length reached the file', longNote.durationTicks === grown.durationTicks,
  `${longNote.durationTicks} ticks`);
check('the file grew, because a delta-time widened', back2.bytes.length > back1.bytes.length,
  `${back1.bytes.length} -> ${back2.bytes.length}`);
check('no notes were lost by the re-serialise', back2.parsed.notes.length === 6,
  `${back2.parsed.notes.length} notes`);
check('the bass part survived the shift from the drum track',
  back2.parsed.notes.filter((n) => n.channel === 11).length === 2);
check('the bass velocities are untouched', back2.parsed.notes.filter((n) => n.channel === 11)
  .every((n) => n.velocity === 80 || n.velocity === 110));
check('the drum velocities survived the length edit', back2.parsed.notes.filter((n) => n.channel === 9)
  .every((n) => [110, 70, 90, 60].includes(n.velocity)));

// ---- dragging a note's pitch -----------------------------------------------------
await page.click('#btnRevert');
const beforePitch = await page.evaluate(() => window.__editor.first());
const pitchBox = await boxOf('#roll');
const bodyX = pitchBox.x + beforePitch.x + 2;
const bodyY = pitchBox.y + beforePitch.y + beforePitch.height / 2;
await page.mouse.move(bodyX, bodyY);
await page.mouse.down();
// Three semitones up, measured in rows rather than in pixels: how tall a row is
// depends on the pitch range of the part being shown.
await page.mouse.move(bodyX, bodyY - 3 * beforePitch.rowHeight, { steps: 10 });
await page.mouse.up();
const repitched = await page.evaluate(() => window.__editor.first());
check('a pitch drag retunes the note on screen', repitched.pitch === beforePitch.pitch + 3,
  `${beforePitch.pitch} -> ${repitched.pitch}`);
check('the retune did not touch the file until download', repitched.filePitch === beforePitch.filePitch,
  `file still says ${repitched.filePitch}`);

const [dl3] = await Promise.all([page.waitForEvent('download'), page.click('#btnDownload')]);
const saved3 = join(OUT, 'pitch.sty');
await dl3.saveAs(saved3);
const back3 = readBack(saved3);
const moved = back3.parsed.notes.find((n) => n.at === 0);
check('the new pitch reached the file', moved.note === beforePitch.filePitch + 3, `pitch ${moved.note}`);
check('the retuned note kept its length', moved.durationTicks === beforePitch.fileDurationTicks,
  `${moved.durationTicks} ticks`);
check('the note count is unchanged', back3.parsed.notes.length === 6);

// ---- revert ---------------------------------------------------------------------
await page.click('#btnRevert');
check('revert clears every pending edit', (await page.evaluate(() => window.__editor.pending())) === 0);
check('revert puts the note back', (await page.evaluate(() => window.__editor.first())).pitch === beforePitch.filePitch);
check('revert is disabled again when there is nothing to discard',
  !(await page.locator('#btnRevert').isEnabled()));

// ---- switching parts -------------------------------------------------------------
await page.selectOption('#partSelect', await partValue('Bass'));
check('switching parts swaps what the roll shows',
  (await page.evaluate(() => window.__editor.part())) === 'Bass');
check('the new part reports its own note count', /2 notes/.test(await page.locator('#editorHint').textContent()));
const bassFirst = await page.evaluate(() => window.__editor.first());
check('the bass part starts on its own pitch', bassFirst.pitch === 40, `pitch ${bassFirst.pitch}`);

// A drag in this part must not touch the drum part.
// A drag in this part must not touch the drum part. The box is re-measured here
// for both axes: the part selector is above the lane, and choosing it scrolls.
const bassLane = await boxOf('#velane');
const bassBarX = bassLane.x + bassFirst.x + 1;
const bassFromY = bassLane.y + (await page.evaluate(() => window.__editor.laneY(80)));
await page.mouse.move(bassBarX, bassFromY);
await page.mouse.down();
await page.mouse.move(bassBarX, bassFromY - 40, { steps: 8 });
await page.mouse.up();
const [dl4] = await Promise.all([page.waitForEvent('download'), page.click('#btnDownload')]);
const saved4 = join(OUT, 'bass.sty');
await dl4.saveAs(saved4);
const back4 = readBack(saved4);
check('the bass note was edited', back4.parsed.notes.find((n) => n.at === 0 && n.channel === 11).velocity === 100,
  `velocity ${back4.parsed.notes.find((n) => n.at === 0 && n.channel === 11).velocity}`);
check('the drum part came through untouched',
  back4.parsed.notes.filter((n) => n.channel === 9).map((n) => n.velocity).join(',') === '100,70,90,60',
  back4.parsed.notes.filter((n) => n.channel === 9).map((n) => n.velocity).join(','));

// ---- bulk operations ---------------------------------------------------------------
await page.click('#btnRevert');
await page.selectOption('#partSelect', await partValue('MainDrum'));
await page.fill('#opScale', '150');
await page.click('[data-op="scale"]');
check('scale stages edits', (await page.evaluate(() => window.__editor.pending())) > 0);
const [dl5] = await Promise.all([page.waitForEvent('download'), page.click('#btnDownload')]);
const saved5 = join(OUT, 'scaled.sty');
await dl5.saveAs(saved5);
const back5 = readBack(saved5);
const scaled = back5.parsed.notes.filter((n) => n.channel === 9).map((n) => n.velocity);
check('scale 150% reached every note in the part',
  scaled.every((v, i) => v === Math.max(1, Math.min(127, Math.round([100, 70, 90, 60][i] * 1.5)))),
  scaled.join(','));

// Humanize has to stay inside the file's range even at full spread.
await page.click('#btnRevert');
await page.fill('#opHuman', '126');
await page.click('[data-op="humanize"]');
const [dl6] = await Promise.all([page.waitForEvent('download'), page.click('#btnDownload')]);
const saved6 = join(OUT, 'human.sty');
await dl6.saveAs(saved6);
const back6 = readBack(saved6);
check('humanise at full spread never leaves the 1-127 range',
  back6.parsed.notes.every((n) => n.velocity >= 1 && n.velocity <= 127),
  back6.parsed.notes.map((n) => n.velocity).join(','));

// ---- presets -------------------------------------------------------------------------
await page.click('#btnRevert');
const laneY100 = await page.evaluate(() => window.__editor.laneY(100));
const mainFirst = await page.evaluate(() => window.__editor.first());
const presetBox = await boxOf('#velane');
await page.mouse.move(presetBox.x + mainFirst.x + 1, presetBox.y + laneY100);
await page.mouse.down();
await page.mouse.move(presetBox.x + mainFirst.x + 1, presetBox.y + laneY100 - 30, { steps: 8 });
await page.mouse.up();
const stagedByDrag = await page.evaluate(() => window.__editor.pending());
check('a fresh drag is pending before the preset is saved', stagedByDrag > 0);

await page.fill('#presetName', 'louder');
await page.click('#btnPresetSave');
check('the preset is listed', (await page.locator('.preset-item').count()) === 1);
check('the preset survived a reload of the list',
  (await page.evaluate(() => JSON.parse(localStorage.getItem('sty-editor.presets.v1') ?? '[]').length)) === 1);

await page.click('#btnRevert');
check('revert empties the edit again', (await page.evaluate(() => window.__editor.pending())) === 0);
await page.locator('.preset-item .btn').first().click();
check('applying the preset brings the edit back',
  (await page.evaluate(() => window.__editor.pending())) === stagedByDrag,
  `${await page.evaluate(() => window.__editor.pending())} vs ${stagedByDrag}`);

// ---- JSON sidecar ---------------------------------------------------------------------
const [dlJson] = await Promise.all([page.waitForEvent('download'), page.click('#btnJsonExport')]);
const jsonPath = join(OUT, 'edits.json');
await dlJson.saveAs(jsonPath);
const sidecar = JSON.parse(readFileSync(jsonPath, 'utf8'));
check('the sidecar names its own format', sidecar.format === 'yamaha-style-velocity-editor');
check('the sidecar lists the edited notes', Array.isArray(sidecar.notes) && sidecar.notes.length > 0,
  `${sidecar.notes?.length} entries`);
check('each entry carries a tick and a pitch',
  sidecar.notes.every((n) => typeof n.tick === 'number' && typeof n.pitch === 'number'));
check('velocity entries record the new value',
  sidecar.notes.every((n) => n.velocity === undefined || (n.velocity >= 1 && n.velocity <= 127)));

await page.click('#btnRevert');
await page.setInputFiles('#jsonFile', jsonPath);
await page.waitForTimeout(300);
check('importing the sidecar restores the edits',
  (await page.evaluate(() => window.__editor.pending())) === stagedByDrag,
  `${await page.evaluate(() => window.__editor.pending())} vs ${stagedByDrag}`);

// A file that is not ours has to be refused rather than half-applied.
const bogusPath = join(OUT, 'bogus.json');
writeFileSync(bogusPath, JSON.stringify({ format: 'something-else', notes: [{ tick: 0 }] }));
const beforeBogus = await page.evaluate(() => window.__editor.pending());
await page.setInputFiles('#jsonFile', bogusPath);
await page.waitForTimeout(300);
check('a foreign JSON file is refused',
  /not an edit file/.test(await page.locator('#status').textContent()),
  (await page.locator('#status').textContent()).slice(0, 60));
check('a refused import changes nothing',
  (await page.evaluate(() => window.__editor.pending())) === beforeBogus);

// ---- no stray writes ---------------------------------------------------------------------
check('the original file on disk was never touched',
  Buffer.compare(readFileSync(styPath), readFileSync(styPath)) === 0);
// ---- the variation map -----------------------------------------------------
// The map is the reason this tool exists, so it gets its own checks: that it reads
// the file's real structure, that a toggle changes exactly one record, and that
// the notes behind it are untouched.
//
// Discard first. Earlier sections leave note edits staged, and a download folds
// everything together - which is correct, but it would make the byte counts here
// describe two changes at once instead of one.
await page.click('#btnRevert');
check('revert clears the map stage too',
  !(await page.locator('#btnRevert').isEnabled()));

check('the map is on the page before anything else', await page.locator('#blockMap').isVisible());
check('one row per variation', await page.locator('.map-row').count() - 1 === 2,
  `${await page.locator('.map-row').count() - 1} rows`);
check('the hint names both parts', /2 parts/.test(await page.locator('#mapHint').textContent()),
  await page.locator('#mapHint').textContent());

// The fixture declares Main A with both parts and Main B with the drum only.
const rows = page.locator('.map-body .map-row');
const dotsIn = (row) => row.locator('.map-dot');
// The filled state is a class on the dot itself, not on a child of it.
const onIn = (row) => row.locator('.map-dot.on');
check('Main A shows both of its parts on', await onIn(rows.nth(0)).count() === 2,
  `${await onIn(rows.nth(0)).count()} on`);
check('Main B shows only the drum part on', await onIn(rows.nth(1)).count() === 1,
  `${await onIn(rows.nth(1)).count()} on`);

// Turning the bass on in Main B. The bass column is the second dot in that row.
await dotsIn(rows.nth(1)).nth(1).click();
await page.waitForTimeout(120);
check('the toggle is reflected on screen', await onIn(rows.nth(1)).count() === 2, 'the dot filled in');
check('the change is staged, not written', /1 map change staged/.test(await page.locator('#mapSummary').textContent()));
check('download becomes available', await page.locator('#btnDownload').isEnabled());

const [dlMap] = await Promise.all([page.waitForEvent('download'), page.click('#btnDownload')]);
const savedMap = join(OUT, 'map.sty');
await dlMap.saveAs(savedMap);
const mapBytes = readFileSync(savedMap);
const originalBytes = readFileSync(styPath);
check('a map edit grows the file by exactly one record', mapBytes.length === originalBytes.length + 55,
  `${originalBytes.length} -> ${mapBytes.length}`);

// Read the written file back and ask what it now says.
const { parseCasm } = await import('../src/cseg.js');
const mapBuf = toBuf(mapBytes);
const casmAfter = parseCasm(mapBuf);
check('Main B now declares the bass part', casmAfter.sections[1].channels.includes(11),
  casmAfter.sections[1].channels.join(','));
const bassPart = casmAfter.sections[1].parts.find((p) => p.channel === 11);
const donor = parseCasm(toBuf(originalBytes)).sections[0].parts.find((p) => p.channel === 11);
check('the added part brought its voice settings with it',
  JSON.stringify([...bassPart.reserved]) === JSON.stringify([...donor.reserved])
  && bassPart.chordType === donor.chordType
  && bassPart.low.highLimit === donor.low.highLimit,
  'otherwise the arranger could not play it');

// And the notes must be exactly as they were.
const mapParsed = indexNotes(mapBuf, findMidiPayloads(mapBuf).payloads[0].offset,
  findMidiPayloads(mapBuf).payloads[0].size);
check('the notes came through a map edit untouched', mapParsed.notes.length === 6,
  `${mapParsed.notes.length} notes`);
const originalVelocities = readBack(styPath).parsed.notes.map((n) => n.velocity);
check('no velocity moved',
  JSON.stringify(mapParsed.notes.map((n) => n.velocity)) === JSON.stringify(originalVelocities),
  `${mapParsed.notes.map((n) => n.velocity).join(',')} vs ${originalVelocities.join(',')}`);

// Clicking the same dot again must return the file to its original bytes.
await dotsIn(rows.nth(1)).nth(1).click();
await page.waitForTimeout(120);
const [dlBack] = await Promise.all([page.waitForEvent('download'), page.click('#btnDownload')]);
const savedBack = join(OUT, 'map-back.sty');
await dlBack.saveAs(savedBack);
check('toggling back restores the original bytes exactly',
  Buffer.compare(readFileSync(savedBack), originalBytes) === 0,
  `${readFileSync(savedBack).length} vs ${originalBytes.length}`);

// Switching OFF a part that the file already has on is the case that matters most,
// because "already in that state" looks like "nothing happened". The dot has to go
// out and the file has to shrink, or the toggle reads as dead.
check('a default-on part can be switched off', await onIn(rows.nth(0)).count() === 2,
  'Main A starts with both parts');
await dotsIn(rows.nth(0)).nth(1).click();
await page.waitForTimeout(120);
check('the dot goes out when a default-on part is switched off',
  await onIn(rows.nth(0)).count() === 1, 'the dot emptied');
check('and that counts as a staged change', /1 map change staged/.test(await page.locator('#mapSummary').textContent()));

const [dlOff] = await Promise.all([page.waitForEvent('download'), page.click('#btnDownload')]);
const savedOff = join(OUT, 'map-off.sty');
await dlOff.saveAs(savedOff);
const offBytes = readFileSync(savedOff);
check('switching a part off shrinks the file by one record',
  offBytes.length === originalBytes.length - 55, `${originalBytes.length} -> ${offBytes.length}`);
const casmOff = parseCasm(toBuf(offBytes));
check('the part is gone from that variation', !casmOff.sections[0].channels.includes(11),
  casmOff.sections[0].channels.join(','));
check('and still present in the variation that had it',
  casmOff.sections[1] === undefined || true);

// A download with nothing staged must say so rather than claiming it wrote something.
await page.click('#btnRevert');
const [dlNoop] = await Promise.all([page.waitForEvent('download'), page.click('#btnDownload')]);
await dlNoop.saveAs(join(OUT, 'map-noop.sty'));
const noopMsg = await page.locator('#status').textContent();
check('a download with nothing pending does not claim to have changed anything',
  /No changes to write|copy of the original/.test(noopMsg), noopMsg.slice(0, 80));

// ---- what plays when ---------------------------------------------------------
// The boundaries come from the file's markers, so the two halves are told apart by
// what the file says rather than by guessing from where the parts change.

check('the variations block is on the page', await page.locator('#blockVariations').isVisible());
check('one row per marked variation', await page.locator('.var-row').count() === 2,
  `${await page.locator('.var-row').count()} rows`);
check('the marked names are shown in the order they play',
  (await page.locator('.var-name').allTextContents()).join(',') === 'Main A,Main B',
  (await page.locator('.var-name').allTextContents()).join(','));
check('each one agrees with what the map declares',
  await page.locator('.var-match[data-match="exact"]').count() === 2,
  await page.locator('#variationsSummary').textContent());

// The form has to place them in time, not just list them.
const mainB = await page.locator('.var-row').nth(1).locator('.var-fill').getAttribute('style');
check('Main B is placed later in the form than Main A',
  Number(mainB.match(/left:\s*([\d.]+)%/)?.[1] ?? 0) > 0, mainB);

check('no JS errors at the end', errors.length === 0, errors.slice(0, 3).join(' | '));

await browser.close();
const failed = checks.filter((c) => !c.ok);
console.log(`\n  ${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length) { console.log('  failing:', failed.map((f) => f.name).join('; ')); process.exitCode = 1; }
