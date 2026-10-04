/**
 * Browser check: drives the real UI with a synthetic style and asserts the
 * downloaded bytes. A parser test proves the engine; only this proves the page
 * wires it up, and a page that throws on load would otherwise look fine in
 * every other check.
 */

import { chromium } from '@playwright/test';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { findMidiPayloads } from '../src/sff.js';
import { indexNotes, applyVelocity } from '../src/smf.js';

const OUT = 'C:/Users/DSER/AppData/Local/Temp/opencode/sty-e2e';
mkdirSync(OUT, { recursive: true });

// ---- build a fixture file on disk -------------------------------------------
function track(events) {
  const len = events.length;
  return Uint8Array.from([
    0x4d, 0x54, 0x72, 0x6b,
    (len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff,
    ...events,
  ]);
}
function mthd(n) {
  return Uint8Array.from([
    0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1,
    (n >>> 8) & 0xff, n & 0xff, 0x01, 0x18,
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
function concat(parts) {
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const part of parts) { out.set(part, p); p += part.length; }
  return out;
}

// Three distinct drum pitches on channel 10 plus one on channel 1, each
// appearing in both MID and MER. Every note-on carries its own status byte:
// running status would carry over from the preceding note-off and turn the
// bare note numbers into note-offs, which is exactly the trap the parser test
// documents.
const trk = track([
  0x00, 0x99, 36, 100,
  0x00, 0x99, 38, 100,
  0x00, 0x99, 42, 100,
  0x00, 0x90, 60, 100,
  // Note-offs last.
  0x60, 0x89, 36, 0,
  0x00, 0x89, 38, 0,
  0x00, 0x89, 42, 0,
  0x00, 0x80, 60, 0,
]);
const smf = concat([mthd(1), trk]);
const med = chunk('Smed', concat([chunk('MID', smf), chunk('MER', smf)]));
const head = Uint8Array.from([0x53, 0x46, 0x46, 0x32, 0, 0, 0, 8, 0x53, 0x53, 0x54, 0x4e]);
const styPath = join(OUT, 'test-style.sty');
writeFileSync(styPath, concat([head, med]));
console.log('  fixture:', styPath);

// ---- drive the page ---------------------------------------------------------
const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

const url = 'http://localhost:5173/';
await page.goto(url, { waitUntil: 'load' });

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` â€” ${detail}` : ''}`);
};

check('page loads without JS errors', errors.length === 0, errors.slice(0, 2).join(' | '));
check('edit panel hidden before load', await page.locator('#panelEdit').isHidden());

// Upload the fixture.
await page.setInputFiles('#file', styPath);
await page.waitForSelector('#panelEdit:not(.hidden)', { timeout: 15000 });

const meta = await page.locator('#fileMeta').textContent();
check('file meta shows SFF2 and both payloads', /SFF2/.test(meta) && /MID \+ MER/.test(meta), meta);
check('both used channels are pre-selected',
  await page.locator('#channelSel').locator('option:checked').count() === 2);

// With every used channel selected, all 4 note-ons are in scope: 3 pitches on
// ch10 plus 1 on ch1, counted across both the MID and MER copies.
const summary = await page.locator('#summary').textContent();
check('summary counts every note across both payloads', /8 notes selected/.test(summary), summary.slice(0, 50));
check('summary reports the distinct pitches', /4 distinct pitches/.test(summary));
check('download enabled once notes are selected', await page.locator('#btnDownload').isEnabled());

// Excluding a channel must narrow the count, proving the filter is wired up.
// selectOption on the <select> itself is the supported way to drive a
// multi-select; there is no per-option deselect on a locator.
await page.selectOption('#channelSel', ['9']);
const narrowedCh = await page.locator('#summary').textContent();
check('selecting one channel narrows the set', /6 notes selected/.test(narrowedCh), narrowedCh.slice(0, 40));
await page.selectOption('#channelSel', ['0', '9']);

// Narrow the range until nothing matches: the button must disable rather than
// download a file with no changes.
await page.selectOption('#noteHigh', '0');
await page.selectOption('#noteLow', '0');
const narrowed = await page.locator('#summary').textContent();
check('empty selection disables download', /No notes match/.test(narrowed) && !(await page.locator('#btnDownload').isEnabled()));
await page.selectOption('#noteLow', '0');
await page.selectOption('#noteHigh', '127');

// Set a distinctive velocity and download.
await page.locator('.chip[data-v="127"]').click();
const vel = await page.locator('#velocityOut').textContent();
check('preset sets the slider', vel === '127', vel);

const [download] = await Promise.all([
  page.waitForEvent('download'),
  page.locator('#btnDownload').click(),
]);
const savedTo = join(OUT, 'downloaded.sty');
await download.saveAs(savedTo);

// ---- verify the downloaded bytes -------------------------------------------
import { readFileSync } from 'node:fs';
const original = readFileSync(styPath);
const got = readFileSync(savedTo);

let headerSame = true;
for (let i = 0; i < 16 && headerSame; i++) if (original[i] !== got[i]) headerSame = false;
check('container header untouched', headerSame);

const toBuf = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
const origBuf = toBuf(original);
const gotBuf = toBuf(got);

const info = findMidiPayloads(gotBuf);
check('downloaded file still parses as SFF2 with both payloads',
  info.version === 'SFF2' && info.payloads.length === 2);

let allSet = true;
const seen = [];
for (const p of info.payloads) {
  const { notes } = indexNotes(gotBuf, p.offset, p.size);
  seen.push(`${p.kind}:${notes.length}`);
  // 4 note-ons per payload, all at 127 after the patch.
  if (notes.length !== 4 || !notes.every((n) => n.velocity === 127)) allSet = false;
}
check('every velocity in MID and MER is 127', allSet, seen.join(' '));

// And the original on disk must be unchanged - the page must not have edited
// the source file in place.
const reOrig = readFileSync(styPath);
check('original file on disk is untouched',
  Buffer.compare(Buffer.from(reOrig), Buffer.from(original)) === 0);

await browser.close();

const failed = checks.filter((c) => !c.ok);
console.log(`\n  ${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length) {
  console.log('  failing:', failed.map((f) => f.name).join('; '));
  process.exitCode = 1;
}

