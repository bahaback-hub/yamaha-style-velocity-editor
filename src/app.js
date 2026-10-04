/**
 * UI wiring.
 *
 * The file is held in memory and never sent anywhere. Everything the user sees
 * comes from the parse, and the download button stays disabled until a file has
 * actually been read, so an empty state can never produce an empty download.
 */

import { findMidiPayloads } from './sff.js';
import { indexNotes, applyVelocity, noteName, CHANNEL_NAMES } from './smf.js';

const $ = (id) => document.getElementById(id);

const el = {
  panelLoad: $('panelLoad'),
  panelEdit: $('panelEdit'),
  drop: $('drop'),
  file: $('file'),
  fileName: $('fileName'),
  fileMeta: $('fileMeta'),
  btnReset: $('btnReset'),
  channelSel: $('channelSel'),
  noteLow: $('noteLow'),
  noteHigh: $('noteHigh'),
  rangeHint: $('rangeHint'),
  velocity: $('velocity'),
  velocityOut: $('velocityOut'),
  btnDownload: $('btnDownload'),
  btnDownloadOrig: $('btnDownloadOrig'),
  summary: $('summary'),
  status: $('status'),
};

/** @type {{name: string, buffer: ArrayBuffer, version: string, notes: any[], payloads: any[]}|null} */
let state = null;

function say(message, kind = '') {
  el.status.textContent = message;
  el.status.className = `status ${kind}`;
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

/** Populate the note range selectors over the full 0-127 span. */
function fillNotes() {
  for (const [sel, value] of [
    [el.noteLow, 0],
    [el.noteHigh, 127],
  ]) {
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

function fillChannels(usedChannels) {
  el.channelSel.textContent = '';
  for (let ch = 0; ch < 16; ch++) {
    const o = document.createElement('option');
    o.value = String(ch);
    const used = usedChannels.has(ch);
    o.textContent = `${String(ch + 1).padStart(2, '0')} — ${CHANNEL_NAMES[ch]}${used ? '' : ' (no notes)'}`;
    if (used) o.selected = true;
    el.channelSel.append(o);
  }
  // If the style only uses channels this tool would not guess at, fall back to
  // "everything selected" rather than presenting an empty selection that
  // silently edits nothing.
  if (![...el.channelSel.options].some((o) => o.selected)) {
    for (const o of el.channelSel.options) o.selected = true;
  }
}

async function loadFile(file) {
  if (!file) return;
  try {
    say('Reading…');
    const buffer = await file.arrayBuffer();
    const info = findMidiPayloads(buffer);

    if (info.payloads.length === 0) {
      throw new Error('No MIDI data found inside this file. It may not be a style, or it may use a layout this tool does not read.');
    }

    // Index every payload so the note list covers both copies of the music.
    const notes = [];
    for (const p of info.payloads) {
      const r = indexNotes(buffer, p.offset, p.size);
      if (r.error) continue;
      for (const n of r.notes) notes.push({ ...n, payload: p.kind });
    }

    if (notes.length === 0) {
      throw new Error('The style contains MIDI data but no note-on events were found in it.');
    }

    state = { name: file.name, buffer, version: info.version, notes, payloads: info.payloads };

    const used = new Set(notes.map((n) => n.channel));
    const usedNames = [...used].sort((a, b) => a - b).map((c) => `ch${c + 1}`).join(', ');

    el.fileName.textContent = file.name;
    el.fileMeta.textContent =
      `${info.version} · ${formatBytes(buffer.byteLength)} · ` +
      `${info.payloads.map((p) => p.kind).join(' + ')} · ` +
      `${notes.length} notes on ${usedNames}`;

    fillChannels(used);
    el.panelLoad.classList.add('hidden');
    el.panelEdit.classList.remove('hidden');
    el.btnDownloadOrig.disabled = false;
    say('Loaded. Choose what to change, then download.', 'ok');
    refresh();
  } catch (err) {
    state = null;
    say(String(err instanceof Error ? err.message : err), 'warn');
  }
}

/** The notes the current filters select. */
function selectedNotes() {
  if (!state) return [];
  const channels = new Set([...el.channelSel.selectedOptions].map((o) => Number(o.value)));
  const low = Number(el.noteLow.value);
  const high = Number(el.noteHigh.value);
  const lo = Math.min(low, high);
  const hi = Math.max(low, high);
  return state.notes.filter((n) => channels.has(n.channel) && n.note >= lo && n.note <= hi);
}

function refresh() {
  if (!state) return;
  const chosen = selectedNotes();
  const lo = Math.min(Number(el.noteLow.value), Number(el.noteHigh.value));
  const hi = Math.max(Number(el.noteLow.value), Number(el.noteHigh.value));
  const v = Number(el.velocity.value);

  el.rangeHint.textContent = `Range ${noteName(lo)} to ${noteName(hi)}`;
  el.velocityOut.textContent = String(v);
  el.btnDownload.disabled = chosen.length === 0;

  if (chosen.length === 0) {
    el.summary.innerHTML = '<b>No notes match</b> — widen the channel or note selection.';
    return;
  }

  const distinct = [...new Set(chosen.map((n) => n.note))].sort((a, b) => a - b);
  const before = chosen.map((n) => n.velocity);
  const unchanged = before.filter((x) => x === v).length;

  const preview = distinct
    .slice(0, 14)
    .map((n) => noteName(n))
    .join(', ');
  const more = distinct.length > 14 ? ` +${distinct.length - 14} more` : '';

  el.summary.innerHTML =
    `<b>${chosen.length}</b> notes selected across ${distinct.length} distinct pitches (${preview}${more}).<br>` +
    `Current velocities: min ${Math.min(...before)}, max ${Math.max(...before)}, ` +
    `average ${(before.reduce((a, b) => a + b, 0) / before.length).toFixed(1)}. ` +
    `Setting all to <b>${v}</b>${unchanged ? ` (${unchanged} already there)` : ''}.`;
}

function download(buffer, filename) {
  const blob = new Blob([buffer], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  // Revoke on the next turn so the navigation has already started.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function editedName() {
  return state.name.replace(/\.sty$/i, '') + '-vel.sty';
}

el.file.addEventListener('change', (e) => loadFile(e.target.files?.[0]));
el.drop.addEventListener('dragover', (e) => e.preventDefault());
el.drop.addEventListener('drop', (e) => {
  e.preventDefault();
  loadFile(e.dataTransfer?.files?.[0]);
});
el.btnReset.addEventListener('click', () => {
  state = null;
  el.file.value = '';
  el.panelEdit.classList.add('hidden');
  el.panelLoad.classList.remove('hidden');
  say('');
});
el.channelSel.addEventListener('change', refresh);
el.noteLow.addEventListener('change', refresh);
el.noteHigh.addEventListener('change', refresh);
el.velocity.addEventListener('input', refresh);
for (const chip of document.querySelectorAll('.chip')) {
  chip.addEventListener('click', () => {
    el.velocity.value = chip.dataset.v;
    refresh();
  });
}
el.btnDownload.addEventListener('click', () => {
  if (!state) return;
  const chosen = selectedNotes();
  if (chosen.length === 0) return;
  const out = applyVelocity(state.buffer, chosen, Number(el.velocity.value));
  download(out, editedName());
  say(`Wrote ${chosen.length} velocities into ${editedName()}.`, 'ok');
});
el.btnDownloadOrig.addEventListener('click', () => {
  if (!state) return;
  download(state.buffer.slice(0), state.name);
});

fillNotes();
