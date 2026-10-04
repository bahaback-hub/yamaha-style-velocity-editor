/**
 * The real exported style, end to end.
 *
 * Every other fixture is small enough to be obviously correct. This one is a real
 * 56 KB export with four thousand notes, twelve channels and eleven thousand
 * events, so it is the only thing that can catch a bug that only appears at scale:
 * a delta-time wider than two bytes, a note that shares a tick with a hundred
 * others, a re-emitted track that no longer matches its container.
 *
 * The file stays on this machine. It is not committed and not uploaded.
 */

import { chromium } from '@playwright/test';
import { mkdirSync, readFileSync, copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const OUT = 'C:/Users/DSER/AppData/Local/Temp/opencode/sty-e2e-real';
mkdirSync(OUT, { recursive: true });
const BASE = `http://localhost:${process.env.PORT ?? '5173'}/`;

// The user's own export, copied out of the workspace rather than referenced in
// place, so the test never touches the original.
const candidates = [
  'C:/Users/DSER/OneDrive/\u0633\u0637\u062d \u0627\u0644\u0645\u0643\u062a\u0628/03~5-16 Karadeniz.T473.STY',
  'C:/Users/DSER/AppData/Local/Temp/opencode/fixtures/karadeniz.sty',
];
const real = candidates.find((p) => existsSync(p));
if (!real) {
  console.log('  no real style available, skipping');
  process.exit(0);
}
const styPath = join(OUT, 'karadeniz.sty');
copyFileSync(real, styPath);

const { findMidiPayloads } = await import('../src/sff.js');
const { indexNotes } = await import('../src/smf.js');
const { serialiseTrack } = await import('../src/track.js');
const toBuf = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);

function parse(path) {
  const bytes = readFileSync(path);
  const buf = toBuf(bytes);
  const info = findMidiPayloads(buf);
  const p = info.payloads[0];
  return { bytes, buf, info, parsed: indexNotes(buf, p.offset, p.size) };
}

const original = parse(styPath);
console.log(`  fixture: ${styPath} (${original.bytes.length} bytes, ${original.parsed.notes.length} notes)`);

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] });
// A tall viewport so the roll and the lane are both on screen at once, as they
// are on a real display.
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message.slice(0, 140)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 140)); });

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const baseline = (() => {
  const map = new Map();
  for (const n of original.parsed.notes) map.set(`${n.channel}:${n.at}:${n.note}`, n.velocity);
  return map;
})();

await page.goto(BASE, { waitUntil: 'load' });
await page.setInputFiles('#file', styPath);
await page.waitForSelector('#panelEdit:not(.hidden)', { timeout: 30000 });

// ---- it loads --------------------------------------------------------------
const meta = await page.locator('#fileMeta').textContent();
check('the real style loads', /4592 notes/.test(meta), meta.slice(0, 110));
check('all twelve sounding parts are listed',
  (await page.locator('#partSelect option').count()) === 12,
  `${await page.locator('#partSelect option').count()} options`);
check('the busiest part opens without trouble', /notes/.test(await page.locator('#editorHint').textContent()));

const painted = await page.locator('#roll').evaluate((c) => {
  const { data } = c.getContext('2d').getImageData(0, 0, c.width, c.height);
  let lit = 0;
  for (let i = 0; i < data.length; i += 4) if ((data[i] + data[i + 1] + data[i + 2]) / 3 > 60) lit++;
  return lit;
});
check('the busiest part paints its notes', painted > 200, `${painted} lit pixels`);

// ---- a drag on the real part ------------------------------------------------
async function boxOf(selector) {
  const locator = page.locator(selector);
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  if (!box) throw new Error(`${selector} has no box`);
  return box;
}
const first = await page.evaluate(() => window.__editor.first());
const laneBox = await boxOf('#velane');
// Drag away from whichever ceiling this note is already against. Plenty of notes
// in a real export sit at 127, and pushing one further up is correctly a no-op -
// so a test that always drags up would report "no edit" and blame the tool.
const upwards = first.velocity + 12 <= 127;
const wantedVelocity = upwards ? first.velocity + 12 : first.velocity - 12;
const startY = laneBox.y + (await page.evaluate((v) => window.__editor.laneY(v), first.velocity));
const barX = laneBox.x + first.x + 1;
const travelY = startY + (upwards ? -24 : 24);
await page.mouse.move(barX, startY);
await page.mouse.down();
await page.mouse.move(barX, travelY, { steps: 10 });
await page.mouse.up();
check('a drag on the real part stages exactly one edit',
  (await page.evaluate(() => window.__editor.pending())) === 1,
  `${await page.evaluate(() => window.__editor.pending())} pending`);

const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btnDownload')]);
const saved = join(OUT, 'karadeniz-vel.sty');
await dl.saveAs(saved);
const after = parse(saved);

check('the download is the same size', after.bytes.length === original.bytes.length,
  `${original.bytes.length} vs ${after.bytes.length}`);
check('every note survived', after.parsed.notes.length === original.parsed.notes.length,
  `${after.parsed.notes.length} notes`);
check('the timeline is unchanged', after.parsed.lengthTicks === original.parsed.lengthTicks,
  `${after.parsed.lengthTicks} ticks`);
check('the tempo map is unchanged',
  JSON.stringify(after.parsed.tempoMap) === JSON.stringify(original.parsed.tempoMap));

let differing = 0;
let wrong = 0;
for (const n of after.parsed.notes) {
  const key = `${n.channel}:${n.at}:${n.note}`;
  const was = baseline.get(key);
  if (was === undefined) continue;
  if (was !== n.velocity) {
    differing++;
    // The one note that was dragged: it must be the only one, and it must have
    // gone up by exactly what the drag asked for.
    const isTheDraggedOne = n.at === first.at && n.note === first.pitch && n.channel === first.channel;
    if (!isTheDraggedOne || n.velocity !== wantedVelocity) wrong++;
  }
}
check('exactly one note changed', differing === 1, `${differing} changed`);
check('and it is the dragged one, by the dragged amount', wrong === 0, `${wrong} unexpected`);

// ---- the untouched bytes really are untouched ---------------------------------
let identical = 0;
for (let i = 0; i < Math.min(original.bytes.length, after.bytes.length); i++) {
  if (original.bytes[i] === after.bytes[i]) identical++;
}
check('the file differs in a single byte',
  original.bytes.length - identical === 1,
  `${original.bytes.length - identical} bytes differ`);

// ---- the whole thing re-emits byte-for-byte ------------------------------------
// The strongest statement available: taking the download apart and putting it back
// together must reproduce it exactly. If this holds, no length edit can corrupt
// this file either.
const track = after.parsed.trackList[0];
const reemitted = serialiseTrack(track.events);
const onDisk = new Uint8Array(after.buf, track.start + 8, track.length);
check('the saved file still re-emits byte-for-byte',
  Buffer.compare(Buffer.from(reemitted), Buffer.from(onDisk)) === 0,
  `${reemitted.length} vs ${onDisk.length} bytes`);

// ---- a length edit on the real file --------------------------------------------
await page.click('#btnRevert');
const rollBox = await boxOf('#roll');
const before = await page.evaluate(() => window.__editor.first());
const edgeX = rollBox.x + before.x + before.width;
const edgeY = rollBox.y + before.y + before.height / 2;
await page.mouse.move(edgeX, edgeY);
await page.mouse.down();
await page.mouse.move(edgeX + 80, edgeY, { steps: 12 });
await page.mouse.up();
const grown = await page.evaluate(() => window.__editor.first());
check('a length drag takes on the real file', grown.durationTicks > before.durationTicks,
  `${before.durationTicks} -> ${grown.durationTicks}`);

const [dl2] = await Promise.all([page.waitForEvent('download'), page.click('#btnDownload')]);
const saved2 = join(OUT, 'karadeniz-len.sty');
await dl2.saveAs(saved2);
const after2 = parse(saved2);
// A delta-time is variable-length, so a resize does not have to change the file
// size - 2392 and 3392 ticks both take two bytes. What has to hold is that the
// content changed, the container still describes itself correctly, and the track
// still re-emits byte-for-byte.
check('the length edit is in the saved file',
  after2.parsed.notes.some((n) => n.at === grown.at && n.channel === grown.channel
    && n.durationTicks === grown.durationTicks),
  `looking for ${grown.durationTicks} ticks at ${grown.at}`);
check('the resized note is the only one that changed length',
  after2.parsed.notes.filter((n) => {
    const was = original.parsed.notes.find((o) => o.at === n.at && o.channel === n.channel && o.note === n.note);
    return was && was.durationTicks !== n.durationTicks;
  }).length === 1);
check('the container still parses as one payload',
  after2.info.payloads.length === 1 && after2.info.payloads[0].size === after2.bytes.length);
check('no notes were lost', after2.parsed.notes.length === original.parsed.notes.length,
  `${after2.parsed.notes.length} notes`);
check('every velocity is still legal', after2.parsed.notes.every((n) => n.velocity >= 1 && n.velocity <= 127));

const track2 = after2.parsed.trackList[0];
check('the rewritten track re-emits byte-for-byte',
  Buffer.compare(
    Buffer.from(serialiseTrack(track2.events)),
    Buffer.from(new Uint8Array(after2.buf, track2.start + 8, track2.length)),
  ) === 0);

// Nothing hanging, and nothing newly overlapping on a key.
let hanging = 0;
const open = new Map();
let overlaps = 0;
for (const n of after2.parsed.notes) {
  if (n.durationTicks === 0) hanging++;
  const key = `${n.channel}:${n.note}`;
  const list = open.get(key) ?? [];
  for (const other of list) if (other.at + other.durationTicks > n.at) overlaps++;
  list.push(n);
  open.set(key, list);
}
check('no note was left without a length', hanging === 0, `${hanging} hanging`);
check('no new overlap on the same key', overlaps === 0, `${overlaps} overlapping`);

// ---- the untouched copy is still on disk, unchanged -------------------------------
// Compared against the bytes captured before the page was ever opened, so this is
// a real check rather than a file compared with itself.
check('the file on disk was never written to',
  Buffer.compare(readFileSync(styPath), Buffer.from(original.bytes)) === 0);
check('the download is a separate file, not an overwrite',
  existsSync(saved) && existsSync(saved2) && saved !== styPath);

check('no JS errors during the whole session', errors.length === 0, errors.slice(0, 3).join(' | '));

await browser.close();
const failed = checks.filter((c) => !c.ok);
console.log(`\n  ${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length) { console.log('  failing:', failed.map((f) => f.name).join('; ')); process.exitCode = 1; }
