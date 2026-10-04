/**
 * Container-style browser checks.
 *
 * inspect.e2e.mjs covers the bare-MIDI export shape that most of a real
 * collection uses. This file covers the SFF2 container path instead: two
 * payloads (MID and MER) that must both be patched, and a payload that cannot be
 * read at all, which has to be reported rather than swallowed.
 */

import { chromium } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { findMidiPayloads } from '../src/sff.js';
import { indexNotes, indexTracksOnly } from '../src/smf.js';

const OUT = 'C:/Users/DSER/AppData/Local/Temp/opencode/sty-e2e';
mkdirSync(OUT, { recursive: true });
const BASE = `http://localhost:${process.env.PORT ?? '5173'}/`;

function track(events) {
  const len = events.length;
  return Uint8Array.from([
    0x4d, 0x54, 0x72, 0x6b,
    (len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff,
    ...events,
  ]);
}
function mthd(n, division = 480) {
  return Uint8Array.from([
    0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1,
    (n >>> 8) & 0xff, n & 0xff,
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
function concat(parts) {
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const part of parts) { out.set(part, p); p += part.length; }
  return out;
}
const sff2Head = () => Uint8Array.from([0x53, 0x46, 0x46, 0x32, 0, 0, 0, 8, 0x53, 0x53, 0x54, 0x4e]);

// Four note-ons per channel, two channels, plus a control-change so the parser
// has to keep skipping non-note events.
const events = [
  0x00, 0xb1, 0x07, 0x3d,
  0x00, 0x91, 60, 100,
  0x60, 0x81, 60, 0,
  0x00, 0x91, 62, 100,
  0x60, 0x81, 62, 0,
  0x00, 0x99, 36, 100,
  0x60, 0x89, 36, 0,
  0x00, 0x99, 42, 100,
  0x60, 0x89, 42, 0,
];
const smf = concat([mthd(1), track(events)]);
// MER stored the way some writers do: bare MTrk chunks, no MThd.
const merBare = concat([Uint8Array.from([0, 0, 0, 0, 1, 0x20]), track(events)]);

const bothPath = join(OUT, 'container.sty');
writeFileSync(bothPath, concat([sff2Head(), chunk('Smed', concat([chunk('MID', smf), chunk('MER', merBare)]))]));

const junkPath = join(OUT, 'unreadable-mer.sty');
writeFileSync(junkPath, concat([sff2Head(), chunk('Smed', concat([chunk('MID', smf), chunk('MER', new Uint8Array(64))]))]));

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message.slice(0, 100)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 100)); });

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

await page.goto(BASE, { waitUntil: 'load' });
check('page loads without JS errors', errors.length === 0, errors.slice(0, 2).join(' | '));
check('edit panel hidden before load', await page.locator('#panelEdit').isHidden());

// ---- both payloads readable -------------------------------------------------
await page.setInputFiles('#file', bothPath);
await page.waitForSelector('#panelEdit:not(.hidden)', { timeout: 20000 });

const meta = await page.locator('#fileMeta').textContent();
check('meta identifies an SFF2 container', /SFF2/.test(meta), meta);
check('meta names both payloads', /MID \+ MER/.test(meta), meta);
check('notes counted across both payloads', /8 notes/.test(meta), meta);

const lanes = await page.locator('.tl-row').count();
check('one lane per sounding channel', lanes === 2, String(lanes));
check('both channels are included by default', await page.locator('.voice.off').count() === 0);

await page.locator('.chip[data-v="40"]').click();
const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btnDownload')]);
const saved = join(OUT, 'container-vel.sty');
await dl.saveAs(saved);

const original = readFileSync(bothPath);
const edited = readFileSync(saved);
check('download keeps the exact length', original.length === edited.length, `${original.length} vs ${edited.length}`);
let headerSame = true;
for (let i = 0; i < 16 && headerSame; i++) if (original[i] !== edited[i]) headerSame = false;
check('container header untouched', headerSame);

const toBuf = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
const got = toBuf(edited);
const info = findMidiPayloads(got);
check('edited file still parses as SFF2 with both payloads', info.version === 'SFF2' && info.payloads.length === 2);

const seen = [];
let allSet = true;
for (const p of info.payloads) {
  let r = indexNotes(got, p.offset, p.size);
  if (r.error) r = indexTracksOnly(got, p.offset, p.size);
  seen.push(`${p.kind}:${r.notes.length}/${r.layout}`);
  if (r.notes.length !== 4 || !r.notes.every((n) => n.velocity === 40)) allSet = false;
}
check('every velocity in MID and headerless MER is 40', allSet, seen.join(' '));
check('original file on disk is untouched', Buffer.compare(Buffer.from(readFileSync(bothPath)), Buffer.from(original)) === 0);

// ---- a payload that cannot be read -----------------------------------------
await page.setInputFiles('#file', junkPath);
await page.waitForSelector('#panelEdit:not(.hidden)', { timeout: 20000 });
const warn = await page.locator('#status').textContent();
check('unreadable payload raises a visible warning', /could not be read/i.test(warn), warn.slice(0, 80));
check('warning says the edit may not reach the instrument', /may play the untouched copy/i.test(warn));
check('warning is styled as a warning, not a success',
  ((await page.locator('#status').getAttribute('class')) ?? '').includes('warn'));
check('the readable copy is still editable', await page.locator('#btnDownload').isEnabled());
check('no JS errors across the session', errors.length === 0, errors.slice(0, 2).join(' | '));

await browser.close();
const failed = checks.filter((c) => !c.ok);
console.log(`\n  ${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length) { console.log('  failing:', failed.map((f) => f.name).join('; ')); process.exitCode = 1; }
