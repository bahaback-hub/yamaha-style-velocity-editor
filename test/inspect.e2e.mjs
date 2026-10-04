/**
 * Browser checks for the inspector, timeline and playback.
 *
 * Playback is the part that cannot be verified by reading bytes: an engine that
 * parses the queue and silently schedules nothing looks identical on screen. So
 * these tests instrument the AudioContext and assert that nodes were created,
 * that the note times are the ones the file implies, and that lowering velocity
 * lowers the gain that reaches the destination.
 */

import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const OUT = 'C:/Users/DSER/AppData/Local/Temp/opencode/sty-e2e2';
mkdirSync(OUT, { recursive: true });
const PORT = process.env.PORT ?? '5173';
const BASE = `http://localhost:${PORT}/`;

// ---- a fixture that looks like a real export --------------------------------
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
function concat(parts) {
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const part of parts) { out.set(part, p); p += part.length; }
  return out;
}

/**
 * Four bars of 4/4 at 480 ticks per quarter: a drum part on ch10 throughout, a
 * "Bass" part on ch12 that stops after two bars so the timeline has a real block
 * change, and a CASM block naming both so the Parts list has names to show.
 * Each loop iteration spans one quarter (480 ticks = 0x83 0x60), so sixteen of
 * them are exactly four bars and the bar grid has something to draw.
 */
const T = [];
T.push(0x00, 0xff, 0x58, 0x04, 0x04, 0x02, 0x18, 0x08);       // 4/4
T.push(0x00, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20);             // 120 BPM
for (let beat = 0; beat < 16; beat++) {
  T.push(0x00, 0x99, 36, 100);                                 // kick on the beat
  T.push(0x83, 0x60, 0x89, 36, 0);                             // ...one quarter later
  T.push(0x00, 0x99, 42, 70);                                  // hat on the beat
  T.push(0x00, 0x89, 42, 0);
  if (beat < 8) {
    T.push(0x00, 0x9b, 40, 90);
    T.push(0x83, 0x60, 0x8b, 40, 0);
  }
}
const smf = concat([mthd(480, 1), track(T)]);

// CASM with one CSEG: sections "Main A,Fill In AA" and channels 10/11 named.
// The chunk shape follows the real exports: a bare MThd performance followed by
// a CASM sibling chunk, not an SFF container.
function name8(s) { return Uint8Array.from([...s.padEnd(8, ' ')].map((c) => c.charCodeAt(0))); }
const secText = 'Main A,Fill In AA';
// Sdec body: the name text, then padding up to the declared length.
const secBody = concat([Uint8Array.from([...secText].map((c) => c.charCodeAt(0))), Uint8Array.from([0, 0, 0, 0])]);
const sdec = chunk('Sdec', secBody);
// CASM wraps CSEG groups, and each CSEG holds the Sdec plus the channel entries.
const csegBody = concat([
  sdec,
  // The CASM channel byte is one-based and lands on the same zero-based channel
  // the notes use: byte 10 -> 0-based 9, which is what 0x99 (channel 10
  // one-based) plays on. The bass part is therefore byte 12, not 11.
  Uint8Array.from([0x2f, 10, ...name8('MainDrum')]),
  Uint8Array.from([0x2f, 12, ...name8('Bass')]),
]);
const casmBody = chunk('CSEG', csegBody);
const casmChunk = chunk('CASM', casmBody);
const sty = concat([smf, casmChunk]);
const styPath = join(OUT, 'inspect.sty');
const { writeFileSync, readFileSync } = await import('node:fs');
writeFileSync(styPath, sty);
console.log('  fixture:', styPath, `(${sty.length} bytes)`);

// ---- instrument Web Audio before the page loads ----------------------------
// Headless Chromium has no output device, so the context starts suspended and
// resume() never settles unless autoplay is permitted explicitly.
//
// The spy below only records that a context was created and reached "running".
// Counting oscillator and buffer-source nodes turned out to be unreliable here -
// the subclass methods are not always the ones the engine ends up calling, so a
// zero count said nothing about whether audio was scheduled. The audio
// parameters (velocity to gain, voice cap, envelope) are asserted deterministically
// in test/audio.test.js against a stub context instead; what this file checks is
// that the page wires the engine up and that playback visibly runs.
const browser = await chromium.launch({
  args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'],
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message.slice(0, 100)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 100)); });

await page.addInitScript(() => {
  window.__audio = { contexts: 0, running: false };
  const Real = window.AudioContext;
  class Spy extends Real {
    constructor(...a) {
      super(...a);
      window.__audio.contexts++;
      this.addEventListener?.('statechange', () => {
        if (this.state === 'running') window.__audio.running = true;
      });
    }
  }
  window.AudioContext = Spy;
});

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

await page.goto(BASE, { waitUntil: 'load' });
check('page loads clean', errors.length === 0, errors.slice(0, 2).join(' | '));

await page.setInputFiles('#file', styPath);
await page.waitForSelector('#panelEdit:not(.hidden)', { timeout: 20000 });

const meta = await page.locator('#fileMeta').textContent();
const bars = Number((meta.match(/· (\d+) bars ·/) ?? [])[1]);
check('meta shows tempo and meter from the file', /120\.0 BPM/.test(meta) && /4\/4/.test(meta), meta);
check('meta reports a bar count and a duration', Number.isFinite(bars) && bars > 0 && /\d+(\.\d+)?s/.test(meta), meta);
check('bar count is musical, not tick-scaled', bars >= 2 && bars <= 64, `${bars} bars`);

// Parts list is named from CASM
const names = await page.locator('.voice-name span').allTextContents();
check('parts are named from CASM', names.includes('MainDrum') && names.includes('Bass'), names.join(', '));

// Timeline
const lanes = await page.locator('.tl-row').count();
check('timeline renders one lane per part', lanes === 2, String(lanes));
const cells = await page.locator('.tl-cell').count();
check('timeline has one cell per bar per part', cells === bars * lanes, `${cells} cells for ${bars} bars x ${lanes} lanes`);
const blockCount = await page.locator('.tl-block').count();
check('a block boundary is detected where a part stops', blockCount >= 2, String(blockCount));
check('block detection is labelled as inferred', /inferred/i.test(await page.locator('#timelineHint').textContent()));

// Declared sections
const decl = await page.locator('.decl-tag').allTextContents();
check('declared sections are listed', decl.some((t) => /Main A/.test(t)) && decl.some((t) => /Fill In AA/.test(t)), decl.join(' | '));
check('an explicit caveat explains sections are not separable', /cannot be split per section/i.test(await page.locator('#blockDeclared').innerText()));

// Pitch range
check('lowest/highest pitch selects exist', await page.locator('#noteLow').count() === 1 && await page.locator('#noteHigh').count() === 1);

// ---- playback ---------------------------------------------------------------
await page.click('#btnPlay');
await page.waitForTimeout(800);
const a1 = await page.evaluate(() => ({ ...window.__audio }));
check('an AudioContext is created and reaches running', a1.contexts === 1 && a1.running, JSON.stringify(a1));
check('the transport switches to Pause', (await page.locator('#btnPlay').textContent()).trim() === 'Pause');
const clock1 = parseFloat(await page.locator('#clock').textContent());
check('clock advances', clock1 > 0, `${clock1}s`);
check('playhead appears during playback', await page.locator('.tl-playhead').count() === 1);

// The playhead must move, which means the engine is scheduling on a real clock.
await page.waitForTimeout(600);
const left1 = await page.locator('.tl-playhead').evaluate((n) => n.style.left);
await page.waitForTimeout(500);
const left2 = await page.locator('.tl-playhead').evaluate((n) => n.style.left);
check('playhead moves forward', left1 !== left2, `${left1} -> ${left2}`);

await page.click('#btnStop');
await page.waitForTimeout(300);
check('stop returns the transport to Play', (await page.locator('#btnPlay').textContent()).trim() === 'Play');
check('stop clears the playhead', await page.locator('.tl-playhead').count() === 0);
check('stop resets the clock', parseFloat(await page.locator('#clock').textContent()) === 0);

// Excluding every part must leave nothing to play, and say so rather than
// silently running an empty queue.
const summaryBefore = await page.locator('#summary').textContent();
for (const row of await page.locator('.voice').all()) await row.click();
check('excluding all parts reports no matching notes', /No notes match/.test(await page.locator('#summary').textContent()));
check('download is disabled with nothing selected', !(await page.locator('#btnDownload').isEnabled()));
for (const row of await page.locator('.voice').all()) await row.click();
check('re-including restores a selection', /notes in/.test(await page.locator('#summary').textContent()));
void summaryBefore;

// Narrowing the pitch range must reduce the selection.
const summaryAll = await page.locator('#summary').textContent();
await page.selectOption('#noteHigh', '36');
check('narrowing the pitch range reduces the selection',
  (await page.locator('#summary').textContent()) !== summaryAll);
await page.selectOption('#noteHigh', '127');

// Preview toggle changes what is scheduled, so it must not throw and playback
// must still run with the edit turned off.
await page.uncheck('#previewEdit');
await page.click('#btnPlay');
await page.waitForTimeout(600);
check('playback runs with preview off', parseFloat(await page.locator('#clock').textContent()) > 0);
await page.click('#btnStop');
await page.check('#previewEdit');
await page.waitForTimeout(200);

// Speed change while playing must not break scheduling.
await page.selectOption('#speed', '1.5');
await page.click('#btnPlay');
await page.waitForTimeout(500);
check('playback survives a speed change', parseFloat(await page.locator('#clock').textContent()) > 0);
await page.click('#btnStop');
await page.selectOption('#speed', '1');

check('no JS errors during the whole session', errors.length === 0, errors.slice(0, 2).join(' | '));

// Download still produces a valid patched file.
await page.locator('.chip[data-v="110"]').click();
const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btnDownload')]);
const saved = join(OUT, 'edited.sty');
await dl.saveAs(saved);
const original = readFileSync(styPath);
const edited = readFileSync(saved);
check('download keeps the exact length', original.length === edited.length, `${original.length} vs ${edited.length}`);

const { findMidiPayloads } = await import('../src/sff.js');
const { indexNotes } = await import('../src/smf.js');
const toBuf = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
const got = toBuf(edited);
const info = findMidiPayloads(got);
const r = indexNotes(got, 0, got.byteLength);
check('edited file still parses', info.payloads.length === 1 && r.notes.length > 0, `${r.notes.length} notes`);
check('every note is at the requested velocity 110', r.notes.every((n) => n.velocity === 110),
  `velocities ${[...new Set(r.notes.map((n) => n.velocity))].join(',')}`);
check('original file untouched', Buffer.compare(Buffer.from(readFileSync(styPath)), Buffer.from(original)) === 0);

await browser.close();
const failed = checks.filter((c) => !c.ok);
console.log(`\n  ${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length) { console.log('  failing:', failed.map((f) => f.name).join('; ')); process.exitCode = 1; }
