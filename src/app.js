/**
 * UI wiring.
 *
 * The file stays in memory and is never sent anywhere. Three things drive the
 * screen:
 *   - the note index, with absolute ticks so anything can be placed in time;
 *   - the style structure read from CASM, which names parts and declares
 *     sections;
 *   - the pending velocity edit, which playback can preview so the change is
 *     judgeable by ear rather than by numbers.
 */

import { findMidiPayloads } from './sff.js';
import { indexNotes, indexTracksOnly, applyVelocity, noteName, tickToSeconds } from './smf.js';
import { readStyleStructure, summariseByChannel, sectionLabel, voiceFamily } from './sections.js';
import { resolveMeter, detectBlocks, presencePerBar, BLOCK_SOURCE } from './timeline.js';
import { Player, velocityToGain } from './audio.js';

const $ = (id) => document.getElementById(id);
const el = {
  panelLoad: $('panelLoad'), panelEdit: $('panelEdit'),
  drop: $('drop'), file: $('file'),
  fileName: $('fileName'), fileMeta: $('fileMeta'), btnReset: $('btnReset'),
  btnPlay: $('btnPlay'), btnStop: $('btnStop'), btnPlayOriginal: $('btnPlayOriginal'),
  speed: $('speed'), volume: $('volume'), clock: $('clock'), previewEdit: $('previewEdit'),
  timeline: $('timeline'), timelineHint: $('timelineHint'),
  voices: $('voices'),
  velocity: $('velocity'), velocityOut: $('velocityOut'),
  noteLow: $('noteLow'), noteHigh: $('noteHigh'),
  btnDownload: $('btnDownload'), btnDownloadOrig: $('btnDownloadOrig'),
  summary: $('summary'),
  declared: $('declared'), declaredHint: $('declaredHint'), blockDeclared: $('blockDeclared'),
  status: $('status'),
};

const LANE = {
  drums: 'var(--fam-drums)', bass: 'var(--fam-bass)', guitar: 'var(--fam-guitar)',
  plucked: 'var(--fam-plucked)', pad: 'var(--fam-pad)', keys: 'var(--fam-keys)',
  brass: 'var(--fam-brass)', voice: 'var(--fam-voice)', other: 'var(--fam-other)',
};
const laneColor = (family) => LANE[family] ?? LANE.other;

// Plain words rather than glyphs: two characters here did not survive an
// earlier shell round-trip of this file and silently became mojibake in the
// transport button.
const PLAY_LABEL = 'Play';
const PAUSE_LABEL = 'Pause';

/** @type {any} */
let state = null;
/** @type {Player|null} */
let player = null;
/** @type {AudioContext|null} */
let audioCtx = null;
let rafId = null;

function say(message, kind = '') {
  el.status.textContent = message;
  el.status.className = `status ${kind}`;
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function fillNotes() {
  for (const [sel, value] of [[el.noteLow, 0], [el.noteHigh, 127]]) {
    sel.textContent = '';
    for (let n = 0; n <= 127; n++) {
      const o = document.createElement('option');
      o.value = String(n);
      o.textContent = `${noteName(n)} (${n})`;
      sel.append(o);
    }
    sel.value = String(value);
  }
}

async function loadFile(file) {
  if (!file) return;
  try {
    say('Readingâ€¦');
    const buffer = await file.arrayBuffer();
    const info = findMidiPayloads(buffer);
    if (info.payloads.length === 0) {
      throw new Error('No MIDI data found inside this file. It may not be a style, or it may use a layout this tool does not read.');
    }

    const notes = [];
    const payloads = [];
    // Timing comes from the first payload that parses: tempo and meter are
    // track-level, and every payload in a style carries the same grid. Parsing
    // once and keeping the result avoids re-walking a 40 KB track three times.
    let tempoMap = null;
    let timeSignature = { numerator: 4, denominator: 4 };
    let division = 0;
    let lengthTicks = 0;
    for (const p of info.payloads) {
      let r = indexNotes(buffer, p.offset, p.size);
      if (r.error) {
        const alt = indexTracksOnly(buffer, p.offset, p.size);
        if (alt.notes.length > 0) r = alt;
        else {
          payloads.push({ kind: p.kind, ok: false, count: 0, detail: r.error });
          continue;
        }
      }
      payloads.push({ kind: p.kind, ok: r.notes.length > 0, count: r.notes.length, layout: r.layout });
      if (!tempoMap) {
        tempoMap = r.tempoMap;
        timeSignature = r.timeSignature;
        division = r.division;
        lengthTicks = r.lengthTicks;
      }
      for (const n of r.notes) notes.push({ ...n, payload: p.kind });
    }
    if (notes.length === 0) {
      throw new Error(`The style contains MIDI data but no readable note events were found. ${info.payloads.map((p) => p.kind).join(' and ')} could not be parsed.`);
    }
    if (!tempoMap) tempoMap = [{ tick: 0, usPerQuarter: 500000 }];
    // The last note-on can sit past the final meta event's tick.
    lengthTicks = Math.max(lengthTicks, ...notes.map((n) => n.at));

    // Structure: CASM names the parts and declares the original sections.
    const structure = readStyleStructure(buffer);
    const stats = summariseByChannel(notes);

    // Which channel carries which voice name. A channel can appear under more
    // than one name across section groups; prefer the first, but keep a list.
    /** @type {Map<number, string[]>} */
    const namesByChannel = new Map();
    for (const v of structure.voices) {
      const list = namesByChannel.get(v.channel) ?? [];
      if (!list.includes(v.name)) list.push(v.name);
      namesByChannel.set(v.channel, list);
    }

    const meter = resolveMeter(timeSignature, lengthTicks, division);
    const tpb = meter.ticksPerBar;

    // Row per channel that has notes, in channel order.
    const rows = [...stats.values()].sort((a, b) => a.channel - b.channel);
    for (const r of rows) {
      r.names = namesByChannel.get(r.channel) ?? [];
      // A channel can carry several names across section groups; the first that
      // classifies is the most informative one.
      r.family = r.names.map(voiceFamily).find((f) => f !== 'other') ?? 'other';
      r.label = r.names.length ? r.names.join(' / ') : `Channel ${r.channel + 1}`;
    }

    state = {
      name: file.name, buffer, version: info.version, container: info.container,
      notes, payloads, structure, stats, rows, tempoMap, timeSignature, lengthTicks, meter, tpb,
      blocks: detectBlocks(notes, meter, tpb, (t) => tickToSeconds(tempoMap, t, division)),
      presence: presencePerBar(notes, meter, tpb),
      selected: new Set(rows.map((r) => r.channel)),
      division,
    };

    renderMeta();
    renderTimeline();
    renderVoices();
    renderDeclared();
    el.panelLoad.classList.add('hidden');
    el.panelEdit.classList.remove('hidden');
    el.btnDownloadOrig.disabled = false;

    const skipped = payloads.filter((p) => !p.ok);
    if (skipped.length) {
      say(`Loaded, but ${skipped.map((p) => p.kind).join(' and ')} could not be read, so the edit will only reach ${payloads.filter((p) => p.ok).map((p) => p.kind).join(' and ')}. Newer arrangers may play the untouched copy.`, 'warn');
    } else {
      say(`Loaded ${notes.length} notes. Click a part to include or exclude it, then play or edit.`, 'ok');
    }
    refresh();
  } catch (err) {
    state = null;
    say(String(err instanceof Error ? err.message : err), 'warn');
  }
}

function renderMeta() {
  const s = state;
  const bpm = 60000000 / (s.tempoMap[0]?.usPerQuarter ?? 500000);
  const secs = tickToSeconds(s.tempoMap, s.lengthTicks, s.division);
  const used = s.rows.map((r) => `ch${r.channel + 1}`).join(', ');
  el.fileName.textContent = s.name;
  el.fileMeta.textContent =
    `${s.version}${s.container === 'bare-smf' ? ' (no SFF container)' : ''} · ${formatBytes(s.buffer.byteLength)} · ` +
    `${s.payloads.map((p) => p.kind).join(' + ')} · ${s.notes.length} notes · ${bpm.toFixed(1)} BPM · ` +
    `${s.meter.numerator}/${s.meter.denominator} · ${s.meter.bars} bars · ${secs.toFixed(1)}s · ${used}`;
}

function renderTimeline() {
  const s = state;
  el.timeline.textContent = '';
  const bars = s.meter.bars;

  // Block ruler
  const ruler = document.createElement('div');
  ruler.className = 'tl-ruler';
  ruler.append(Object.assign(document.createElement('div'), { className: 'tl-name' }));
  const blockWrap = document.createElement('div');
  blockWrap.className = 'tl-blocks';
  for (const b of s.blocks) {
    const d = document.createElement('div');
    d.className = 'tl-block';
    d.style.flex = String(Math.max(1, b.endBar - b.startBar));
    d.textContent = b.endBar - b.startBar >= 3 ? b.label : '';
    d.title = `${b.label}: bars ${b.startBar + 1}â€“${b.endBar}, ${b.channels.length} part(s)`;
    blockWrap.append(d);
  }
  if (s.blocks.length === 0) {
    const d = document.createElement('div');
    d.className = 'tl-block';
    d.style.flex = '1';
    d.textContent = 'no notes';
    blockWrap.append(d);
  }
  ruler.append(blockWrap);
  el.timeline.append(ruler);

  // One lane per part
  for (const r of s.rows) {
    const row = document.createElement('div');
    row.className = 'tl-row';
    const name = document.createElement('div');
    name.className = 'tl-name';
    name.textContent = r.label;
    name.title = `Channel ${r.channel + 1}`;
    const lanes = document.createElement('div');
    lanes.className = 'tl-lanes';
    const counts = s.presence.get(r.channel) ?? [];
    const peak = Math.max(1, ...counts);
    for (let bar = 0; bar < bars; bar++) {
      const c = document.createElement('div');
      c.className = 'tl-cell';
      const n = counts[bar] ?? 0;
      if (n > 0) {
        c.classList.add('on');
        c.style.setProperty('--lane', laneColor(r.family));
        c.style.setProperty('--a', String(0.3 + 0.7 * Math.min(1, n / peak)));
        c.title = `Bar ${bar + 1}: ${n} note(s)`;
      }
      lanes.append(c);
    }
    row.append(name, lanes);
    el.timeline.append(row);
  }

  const inferred = s.blocks.every((b) => b.source === BLOCK_SOURCE.inferred) && s.blocks.length > 0;
  const notes = [
    inferred ? 'Blocks are inferred from where the sounding parts change - the file stores no section boundaries.' : '',
    s.meter.source === BLOCK_SOURCE.inferred && s.meter.note ? `Grid uses 4/4: ${s.meter.note}.` : '',
  ].filter(Boolean).join(' ');
  el.timelineHint.textContent = notes || `${bars} bars`;
}

function renderVoices() {
  el.voices.textContent = '';
  if (state.rows.length === 0) {
    el.voices.innerHTML = '<p class="empty">No parts found.</p>';
    return;
  }
  for (const r of state.rows) {
    const row = document.createElement('div');
    row.className = 'voice' + (state.selected.has(r.channel) ? '' : ' off');
    row.style.setProperty('--lane', laneColor(r.family));
    row.dataset.channel = String(r.channel);
    row.setAttribute('role', 'checkbox');
    row.setAttribute('tabindex', '0');
    row.setAttribute('aria-checked', String(state.selected.has(r.channel)));
    const avg = r.velSum / r.count;
    row.innerHTML =
      `<div class="voice-name"><span>${esc(r.label)}</span></div>` +
      `<div class="voice-ch">ch ${r.channel + 1}</div>` +
      `<div class="voice-pitch">${noteName(r.low)}â€“${noteName(r.high)}<div class="bar-mini"><i style="width:${Math.min(100, (r.count / Math.max(...state.rows.map((x) => x.count))) * 100).toFixed(0)}%"></i></div></div>` +
      `<div class="voice-vel">vel <b>${r.velMin}â€“${r.velMax}</b> · avg ${avg.toFixed(0)}</div>`;
    el.voices.append(row);
  }
}

function renderDeclared() {
  const s = state;
  el.declared.textContent = '';
  if (!s.structure.found || s.structure.declaredSections.length === 0) {
    el.blockDeclared.classList.add('hidden');
    return;
  }
  el.blockDeclared.classList.remove('hidden');
  for (const name of s.structure.declaredSections) {
    const tag = document.createElement('span');
    tag.className = 'decl-tag';
    tag.innerHTML = `<b>${esc(sectionLabel(name))}</b> ${esc(name)}`;
    el.declared.append(tag);
  }
  const notice = document.createElement('p');
  notice.className = 'notice';
  notice.textContent =
    'These names come from the original style. This export stores no section boundaries in time, ' +
    'so the notes above cannot be split per section - they are grouped by part.';
  el.declared.append(notice);
  el.declaredHint.textContent = `declared by the style · ${s.structure.declaredSections.length} sections`;
}

function selectedNotes() {
  if (!state) return [];
  const lo = Math.min(Number(el.noteLow.value), Number(el.noteHigh.value));
  const hi = Math.max(Number(el.noteLow.value), Number(el.noteHigh.value));
  return state.notes.filter((n) => state.selected.has(n.channel) && n.note >= lo && n.note <= hi);
}

/** Velocity a note would play with, honouring the pending edit. */
function previewVelocity(n) {
  const lo = Math.min(Number(el.noteLow.value), Number(el.noteHigh.value));
  const hi = Math.max(Number(el.noteLow.value), Number(el.noteHigh.value));
  const inRange = state.selected.has(n.channel) && n.note >= lo && n.note <= hi;
  return inRange ? Number(el.velocity.value) : n.velocity;
}

function refresh() {
  if (!state) return;
  const chosen = selectedNotes();
  const lo = Math.min(Number(el.noteLow.value), Number(el.noteHigh.value));
  const hi = Math.max(Number(el.noteLow.value), Number(el.noteHigh.value));
  const v = Number(el.velocity.value);
  el.velocityOut.textContent = String(v);
  el.btnDownload.disabled = chosen.length === 0;
  for (const c of document.querySelectorAll('.chip[data-v]')) {
    c.setAttribute('aria-pressed', String(c.dataset.v === String(v)));
  }
  if (chosen.length === 0) {
    el.summary.innerHTML = '<b>No notes match</b> - include a part or widen the pitch range.';
    return;
  }
  const distinct = [...new Set(chosen.map((n) => n.note))].sort((a, b) => a - b);
  const before = chosen.map((n) => n.velocity);
  const unchanged = before.filter((x) => x === v).length;
  const parts = [...new Set(chosen.map((n) => n.channel))].length;
  const preview = distinct.slice(0, 12).map((n) => noteName(n)).join(', ');
  const more = distinct.length > 12 ? ` +${distinct.length - 12} more` : '';
  const quiet = Math.round((chosen.filter((n) => n.velocity < 60).length / chosen.length) * 100);
  el.summary.innerHTML =
    `<b>${chosen.length}</b> notes in <b>${parts}</b> part(s), ${distinct.length} pitches (${preview}${more})<br>` +
    `Current velocity: min ${Math.min(...before)}, max ${Math.max(...before)}, avg ${(before.reduce((a, b) => a + b, 0) / before.length).toFixed(1)}. ` +
    `${quiet}% are below 60. Setting all to <b>${v}</b>${unchanged ? ` (${unchanged} already there)` : ''}.`;
}

function download(buffer, filename) {
  const blob = new Blob([buffer], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

const editedName = () => state.name.replace(/\.sty$/i, '') + '-vel.sty';

// ---- playback ----

async function ensureAudio() {
  if (!audioCtx) {
    const Ctor = window.AudioContext ?? window.webkitAudioContext;
    audioCtx = new Ctor();
  }
  if (audioCtx.state === 'suspended') await audioCtx.resume();
  return audioCtx;
}

async function play(usePreview) {
  if (!state) return;
  const ctx = await ensureAudio();
  if (!player) player = new Player(ctx);

  const familyOf = (n) => (state.rows.find((r) => r.channel === n.channel)?.family) ?? 'other';
  const useEdit = usePreview && el.previewEdit.checked;
  const vel = useEdit ? previewVelocity : (n) => n.velocity;

  // Only schedule notes that are audible: a part toggled off should go silent,
  // which is what makes a row a usable auditioning control.
  const audible = state.notes.filter((n) => state.selected.has(n.channel));

  player.load(audible, { tempoMap: state.tempoMap, timeSignature: state.timeSignature, division: state.division },
    (t) => tickToSeconds(state.tempoMap, t, state.division), familyOf, vel);
  player.setSpeed(Number(el.speed.value));
  player.master.gain.value = Number(el.volume.value) / 100;
  player.onEnded = () => {
    el.btnPlay.textContent = PLAY_LABEL;
    cancelAnimationFrame(rafId);
  };
  player.start(0);
  el.btnPlay.textContent = PAUSE_LABEL;
  tickPlayhead();
}

function stopPlayback() {
  player?.stop();
  el.btnPlay.textContent = PLAY_LABEL;
  cancelAnimationFrame(rafId);
  const ph = document.querySelector('.tl-playhead');
  ph?.remove();
  el.clock.textContent = '0.0s';
}

function tickPlayhead() {
  if (!player?.playing) return;
  const secs = player.position();
  el.clock.textContent = `${secs.toFixed(1)}s`;
  let ph = document.querySelector('.tl-playhead');
  if (!ph) {
    ph = document.createElement('div');
    ph.className = 'tl-playhead';
    el.timeline.style.position = 'relative';
    el.timeline.append(ph);
  }
  const total = Math.max(0.001, tickToSeconds(state.tempoMap, state.lengthTicks, state.division));
  ph.style.left = `${Math.min(100, (secs / total) * 100)}%`;
  rafId = requestAnimationFrame(tickPlayhead);
}

// ---- events ----

el.file.addEventListener('change', (e) => loadFile(e.target.files?.[0]));
el.drop.addEventListener('dragover', (e) => e.preventDefault());
el.drop.addEventListener('drop', (e) => { e.preventDefault(); loadFile(e.dataTransfer?.files?.[0]); });

el.btnReset.addEventListener('click', () => {
  stopPlayback();
  state = null;
  el.file.value = '';
  el.panelEdit.classList.add('hidden');
  el.panelLoad.classList.remove('hidden');
  say('');
});

el.voices.addEventListener('click', (e) => {
  const row = e.target.closest('.voice');
  if (!row || !state) return;
  const ch = Number(row.dataset.channel);
  if (state.selected.has(ch)) state.selected.delete(ch);
  else state.selected.add(ch);
  row.classList.toggle('off', !state.selected.has(ch));
  row.setAttribute('aria-checked', String(state.selected.has(ch)));
  refresh();
});
el.voices.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.target.click(); }
});

el.noteLow.addEventListener('change', refresh);
el.noteHigh.addEventListener('change', refresh);
el.velocity.addEventListener('input', refresh);
for (const chip of document.querySelectorAll('.chip[data-v]')) {
  chip.addEventListener('click', () => { el.velocity.value = chip.dataset.v; refresh(); });
}

el.btnPlay.addEventListener('click', () => {
  if (player?.playing) {
    stopPlayback();
    return;
  }
  play(true).catch((err) => say(`Playback failed: ${err?.message ?? err}`, 'warn'));
});
el.btnStop.addEventListener('click', stopPlayback);
el.btnPlayOriginal.addEventListener('click', () =>
  play(false).catch((err) => say(`Playback failed: ${err?.message ?? err}`, 'warn')),
);
el.speed.addEventListener('change', () => player?.setSpeed(Number(el.speed.value)));
el.volume.addEventListener('input', () => { if (player) player.master.gain.value = Number(el.volume.value) / 100; });
el.previewEdit.addEventListener('change', () => { if (player?.playing) { stopPlayback(); play(true); } });

el.btnDownload.addEventListener('click', () => {
  if (!state) return;
  const chosen = selectedNotes();
  if (!chosen.length) return;
  download(applyVelocity(state.buffer, chosen, Number(el.velocity.value)), editedName());
  say(`Wrote ${chosen.length} velocities into ${editedName()}.`, 'ok');
});
el.btnDownloadOrig.addEventListener('click', () => state && download(state.buffer.slice(0), state.name));

fillNotes();

