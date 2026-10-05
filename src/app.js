/**
 * UI wiring.
 *
 * The file stays in memory and is never sent anywhere. Four things drive the
 * screen:
 *   - the note index, with absolute ticks so anything can be placed in time;
 *   - the style structure read from CASM, which names parts and declares
 *     sections;
 *   - a pending edit, held as two maps rather than as a rewritten buffer, so a
 *     drag is instant and reversible;
 *   - playback, which can preview the pending edit so a change is judgeable by
 *     ear rather than by numbers.
 *
 * Why pending edits are maps and not a new buffer: a length edit shifts every byte
 * after it, so the parser's offsets - which the velocity lane keys on - are only
 * valid for the buffer they came from. Keeping velocity and shape edits as
 * intentions, and only writing them at download time, means the two layers never
 * invalidate each other's numbers mid-gesture.
 */

import { findMidiPayloads } from './sff.js';
import {
  indexNotes, indexTracksOnly, applyVelocity, applyVelocities, noteName, tickToSeconds,
} from './smf.js';
import { readStyleStructure, summariseByChannel, sectionLabel, voiceFamily } from './sections.js';
import { resolveMeter, detectBlocks, presencePerBar, BLOCK_SOURCE } from './timeline.js';
import { Player } from './audio.js';
import { PianoRoll } from './pianoroll.js';
import {
  VelocityLane, scaleVelocity, offsetVelocity, humanizeVelocity,
  randomVelocity, curveVelocity, accentVelocity,
} from './velocity-lane.js';
import { applyEdits, findCollisions, clampVelocity } from './edits.js';
import {
  parseCasm, writeCasm, casmWithEdits, styleParts, applyCasmOperations,
} from './cseg.js';
import { MapView, describeMap } from './map-view.js';
import { VariationView } from './variation-view.js';
import { buildVariations } from './variations.js';
import { NoteLift } from './note-lift.js';

const $ = (id) => document.getElementById(id);
const el = {
  panelLoad: $('panelLoad'), panelEdit: $('panelEdit'),
  drop: $('drop'), file: $('file'),
  fileName: $('fileName'), fileMeta: $('fileMeta'), btnReset: $('btnReset'),
  btnPlay: $('btnPlay'), btnStop: $('btnStop'), btnPlayOriginal: $('btnPlayOriginal'),
  speed: $('speed'), volume: $('volume'), clock: $('clock'), previewEdit: $('previewEdit'),
  timeline: $('timeline'), timelineHint: $('timelineHint'),
  voices: $('voices'),
  velocity: $('velocity'), velocityOut: $('velocityOut'), btnApplySet: $('btnApplySet'),
  noteLow: $('noteLow'), noteHigh: $('noteHigh'),
  btnDownload: $('btnDownload'), btnDownloadOrig: $('btnDownloadOrig'),
  summary: $('summary'),
  declared: $('declared'), declaredHint: $('declaredHint'), blockDeclared: $('blockDeclared'),
  status: $('status'),
  map: $('map'), mapHint: $('mapHint'), mapSummary: $('mapSummary'),
  blockMap: $('blockMap'), btnCopyMap: $('btnCopyMap'), saveHint: $('saveHint'),
  vars: $('vars'), variationsHint: $('variationsHint'), variationsSummary: $('variationsSummary'),
  blockVariations: $('blockVariations'), lift: $('lift'),

  partSelect: $('partSelect'), snap: $('snap'), followPlay: $('followPlay'),
  btnFit: $('btnFit'), btnRevert: $('btnRevert'), editCount: $('editCount'),
  roll: $('roll'), velane: $('velane'), rollEmpty: $('rollEmpty'), editorHint: $('editorHint'),

  opScale: $('opScale'), opOffset: $('opOffset'), opHuman: $('opHuman'),
  opRandLow: $('opRandLow'), opRandHigh: $('opRandHigh'),
  opCurvePivot: $('opCurvePivot'), opCurveBelow: $('opCurveBelow'), opCurveAbove: $('opCurveAbove'),
  opAccentAbove: $('opAccentAbove'), opAccentBy: $('opAccentBy'),

  presetName: $('presetName'), presetList: $('presetList'), btnPresetSave: $('btnPresetSave'),
  btnJsonExport: $('btnJsonExport'), btnJsonImport: $('btnJsonImport'), jsonFile: $('jsonFile'),
};

// Two palettes over the same families. `var(--fam-drums)` works in CSS but means
// nothing to a canvas - fillStyle silently keeps whatever colour it had, which is
// how every part ended up the same shade of grey - so the canvas gets real hex.
const LANE = {
  drums: 'var(--fam-drums)', bass: 'var(--fam-bass)', guitar: 'var(--fam-guitar)',
  plucked: 'var(--fam-plucked)', pad: 'var(--fam-pad)', keys: 'var(--fam-keys)',
  brass: 'var(--fam-brass)', voice: 'var(--fam-voice)', other: 'var(--fam-other)',
};
const LANE_HEX = {
  drums: '#e8735a', bass: '#e8a33d', guitar: '#4ec9a0', plucked: '#8ab4f8',
  pad: '#c08ff0', keys: '#6bc9d4', brass: '#e8c95a', voice: '#f09ac0', other: '#93a1b0',
};
const laneColor = (family) => LANE[family] ?? LANE.other;
const laneHex = (family) => LANE_HEX[family] ?? LANE_HEX.other;

// Plain words rather than glyphs: two characters here did not survive an
// earlier shell round-trip of this file and silently became mojibake in the
// transport button.
const PLAY_LABEL = 'Play';
const PAUSE_LABEL = 'Pause';

const PRESET_KEY = 'sty-editor.presets.v1';

/** @type {any} */
let state = null;
/** @type {Player|null} */
let player = null;
/** @type {AudioContext|null} */
let audioCtx = null;
/** @type {PianoRoll|null} */
let roll = null;
/** @type {VelocityLane|null} */
let lane = null;
/** @type {MapView|null} */
let mapView = null;
/** @type {VariationView|null} */
let variationView = null;
/** @type {NoteLift|null} */
let noteLift = null;
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

// ---- pending edits ----------------------------------------------------------

/**
 * A note's identity, stable across re-parses.
 *
 * Velocity edits are keyed by file offset, which is exact but dies the moment a
 * length edit shifts the bytes behind it. These five fields survive that: a
 * structural edit moves a release, never an onset, so a note-on's track, tick,
 * channel and pitch still name the same note in the rewritten file.
 */
const noteKey = (n) => `${n.payloadIndex}:${n.track}:${n.at}:${n.channel}:${n.note}`;

const pendingVelocityOf = (n) => state?.pendingVelocity.get(noteKey(n)) ?? null;
const pendingShapeOf = (n) => state?.pendingShape.get(noteKey(n)) ?? null;

/** Record an edit, dropping it again if it matches what the file already says. */
function stageEdit(note, patch) {
  const key = noteKey(note);
  const base = note.velocity;
  const shape = { ...(state.pendingShape.get(key) ?? {}) };
  let velocity = state.pendingVelocity.get(key);

  if (patch.velocity !== undefined) velocity = clampVelocity(patch.velocity);
  if (patch.pitch !== undefined) shape.pitch = patch.pitch;
  if (patch.durationTicks !== undefined) shape.durationTicks = Math.max(1, Math.round(patch.durationTicks));

  if (velocity === null || velocity === undefined || velocity === base) state.pendingVelocity.delete(key);
  else state.pendingVelocity.set(key, velocity);

  const originalPitch = note.note;
  const originalLength = note.durationTicks;
  const pitch = shape.pitch ?? originalPitch;
  const length = shape.durationTicks ?? originalLength;
  if (pitch === originalPitch && length === originalLength) state.pendingShape.delete(key);
  else state.pendingShape.set(key, shape);
}

/**
 * The values a note should be drawn and heard with.
 *
 * Read off the pending maps rather than mutated into the note, so a reverted edit
 * needs no undo history and the original parse is never touched.
 */
function effective(note) {
  const shape = pendingShapeOf(note);
  return {
    velocity: pendingVelocityOf(note) ?? note.velocity,
    pitch: shape?.pitch ?? note.note,
    durationTicks: shape?.durationTicks ?? note.durationTicks,
  };
}

/** A tick as "bar 3", for saying where something happened. */
function barLabel(tick) {
  if (!state) return 'bar 1';
  return `bar ${Math.floor(tick / state.tpb) + 1}`;
}

/**
 * Stage a new note, or drop one.
 *
 * Added and removed notes are held apart from the two maps above because they are
 * not edits *to* a note: the note a removal refers to does not exist after it, and
 * an addition has no parsed note to hang a velocity or shape on. Keeping them in
 * their own lists means revert, the pending count, and the "nothing to write"
 * download all treat them the same way as everything else.
 *
 * `added` is a list rather than a map keyed by note, because a note the file does
 * not have has no stable identity: two notes added at the same tick and pitch are
 * two notes, and keying them by position would merge them.
 */
function stageAddition(add) {
  state.added.push(add);
  say(`Added ${noteName(add.pitch)} at ${barLabel(add.at)}.`, 'ok');
}

function stageRemoval(note) {
  // Removing a note that is itself new is just undoing the addition.
  const asNew = state.added.findIndex(
    (a) => a.at === note.at && a.pitch === note.note && a.channel === note.channel,
  );
  if (asNew >= 0) { state.added.splice(asNew, 1); return; }
  if (state.removed.has(note)) return;
  state.removed.add(note);
  state.pendingVelocity.delete(noteKey(note));
  state.pendingShape.delete(noteKey(note));
  say(`Removed ${noteName(note.note)} at ${barLabel(note.at)}.`, 'ok');
}

/** Undo a removal, so a note brought back is the one that was there. */
function unstageRemoval(note) {
  if (!state.removed.delete(note)) return;
  say(`Restored ${noteName(note.note)} at ${barLabel(note.at)}.`, 'ok');
}

const isRemoved = (note) => state?.removed.has(note) ?? false;
const pendingCount = () => (state
  ? state.pendingVelocity.size + state.pendingShape.size + state.added.length + state.removed.size
  : 0);

/** The notes an operation should touch: the shown part, inside the pitch range. */
function editableNotes() {
  if (!state) return [];
  const lo = Math.min(Number(el.noteLow.value), Number(el.noteHigh.value));
  const hi = Math.max(Number(el.noteLow.value), Number(el.noteHigh.value));
  return state.notes.filter((n) => n.channel === state.activeChannel && n.note >= lo && n.note <= hi);
}

// ---- loading ----------------------------------------------------------------

/**
 * Read every payload in the file and merge their notes into one timeline.
 *
 * Returns the merged view plus the per-payload parse, because the two are needed
 * together: the merged view is what the editor draws, and the per-payload parse is
 * what an edit has to be applied to.
 */
function parseAll(buffer) {
  const info = findMidiPayloads(buffer);
  const notes = [];
  const payloads = [];
  const parsedByPayload = [];
  let tempoMap = null;
  let timeSignature = { numerator: 4, denominator: 4 };
  let division = 0;
  let lengthTicks = 0;
  // The markers live in the performance track. Whichever payload carries them
  // describes the whole style's variation order, so the first set found is used.
  // A track that holds markers but no notes still counts - it is read before the
  // note check bails out, otherwise its boundaries are silently dropped.
  let spans = [];
  let foundMarkers = false;

  for (let i = 0; i < info.payloads.length; i++) {
    const p = info.payloads[i];
    let r = indexNotes(buffer, p.offset, p.size);
    if (!foundMarkers && r.sectionSpans?.some((s) => s.markerIndex !== null)) {
      spans = r.sectionSpans;
      foundMarkers = true;
    }
    if (r.error) {
      const alt = indexTracksOnly(buffer, p.offset, p.size);
      if (alt.notes.length > 0) r = alt;
      else {
        payloads.push({ kind: p.kind, ok: false, count: 0, detail: r.error });
        parsedByPayload.push(null);
        continue;
      }
    }
    payloads.push({ kind: p.kind, ok: r.notes.length > 0, count: r.notes.length, layout: r.layout });
    parsedByPayload.push({ descriptor: p, parsed: r });
    if (!tempoMap) {
      tempoMap = r.tempoMap;
      timeSignature = r.timeSignature;
      division = r.division;
      lengthTicks = r.lengthTicks;
    }
    // payloadIndex routes an edit back to the copy of the music it belongs to.
    for (const n of r.notes) notes.push({ ...n, payloadIndex: i, payload: p.kind });
  }

  if (notes.length === 0) {
    throw new Error(`The style contains MIDI data but no readable note events were found. ${info.payloads.map((p) => p.kind).join(' and ')} could not be parsed.`);
  }
  if (!tempoMap) tempoMap = [{ tick: 0, usPerQuarter: 500000 }];
  // The last note-on can sit past the final meta event's tick.
  lengthTicks = Math.max(lengthTicks, ...notes.map((n) => n.at));
  return { info, notes, payloads, parsedByPayload, tempoMap, timeSignature, division, lengthTicks, spans };
}

async function loadFile(file) {
  if (!file) return;
  try {
    say('Reading\u2026');
    const buffer = await file.arrayBuffer();
    const parsed = parseAll(buffer);
    const { info, notes, payloads, parsedByPayload, tempoMap, timeSignature, division, lengthTicks, spans } = parsed;

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

    // Variations, from the markers, joined with the declared map. Built once here
    // because it is a pass over every note; every render reads the result.
    const variations = buildVariations(
      { sectionSpans: spans, notes, lengthTicks, division, tempoMap },
      parseCasm(buffer),
      { ticksPerBar: tpb },
    );

    // Row per channel that has notes, in channel order.
    const rows = [...stats.values()].sort((a, b) => a.channel - b.channel);
    for (const r of rows) {
      r.names = namesByChannel.get(r.channel) ?? [];
      // A channel can carry several names across section groups; the first that
      // classifies is the most informative one.
      r.family = r.names.map(voiceFamily).find((f) => f !== 'other') ?? 'other';
      r.label = r.names.length ? r.names.join(' / ') : `Channel ${r.channel + 1}`;
      r.color = laneColor(r.family);
      r.hex = laneHex(r.family);
    }

    state = {
      name: file.name, buffer, version: info.version, container: info.container,
      notes, payloads, parsedByPayload, structure, stats, rows,
      tempoMap, timeSignature, lengthTicks, meter, tpb, division,
      spans, variations,
      blocks: detectBlocks(notes, meter, tpb, (t) => tickToSeconds(tempoMap, t, division)),
      presence: presencePerBar(notes, meter, tpb),
      selected: new Set(rows.map((r) => r.channel)),
      activeChannel: rows.length ? rows[0].channel : -1,
      pendingVelocity: new Map(),
      pendingShape: new Map(),
      // Notes being taken out and put in. Separate from the maps above because
      // they are not edits to a note that exists - see stageAddition.
      removed: new Set(),
      added: [],
      // Which variation the note tools are aimed at, and how wide "here" is.
      variationIndex: 0,
      liftScope: 'all',
      // Section-map edits, as intentions replayed onto a fresh parse. See the note
      // on casmWithEdits: the CASM offset moves when a note edit changes the length
      // of the track in front of it.
      casmOps: [],
      casmError: null,
      // Set only once the slider or a chip has been touched. Null means "no bulk
      // intent", so a download after nothing but a lane drag writes only the
      // dragged notes instead of flattening every part to the slider value.
      bulkVelocity: null,
    };

    // Reveal the panel before the canvases are built. Both classes size their
    // backing store from clientWidth/clientHeight, and a canvas inside a
    // display:none panel measures zero - so mounting first would leave them at
    // the 300x150 default with a one-pixel view of the world.
    el.panelLoad.classList.add('hidden');
    el.panelEdit.classList.remove('hidden');

    mountCanvases();
    mountMap();
    mountVariations();
    mountLift();
    renderMeta();
    renderPartSelect();
    renderTimeline();
    renderVoices();
    renderDeclared();
    setActivePart(state.activeChannel, { fit: true });
    el.btnDownloadOrig.disabled = false;

    const skipped = payloads.filter((p) => !p.ok);
    if (skipped.length) {
      say(`Loaded, but ${skipped.map((p) => p.kind).join(' and ')} could not be read, so the edit will only reach ${payloads.filter((p) => p.ok).map((p) => p.kind).join(' and ')}. Newer arrangers may play the untouched copy.`, 'warn');
    } else {
      say(`Loaded ${notes.length} notes. Pick a part, then drag in the velocity lane or the roll.`, 'ok');
    }
    refresh();
  } catch (err) {
    state = null;
    say(String(err instanceof Error ? err.message : err), 'warn');
  }
}

// ---- canvases ---------------------------------------------------------------

function mountCanvases() {
  const timing = {
    division: state.division, ticksPerBar: state.tpb, lengthTicks: state.lengthTicks,
  };
  const part = () => state.rows.find((r) => r.channel === state.activeChannel) ?? null;

  roll = new PianoRoll(el.roll, {
    onSelect: (note) => { if (lane) lane.selected = note; },
    // Every gesture ends in the same two steps: repaint with the new override,
    // and refresh the counters. Without the refresh the edit count and the
    // download button would keep describing the state before the drag.
    onEdit: (note, patch) => { stageEdit(note, patch); afterEdit(); },
    onCommit: afterEdit,
    onSeek: (tick) => seekTo(tick),
    onToggleRemove: (note) => {
      if (isRemoved(note)) unstageRemoval(note);
      else stageRemoval(note);
      afterEdit();
    },
    onAddNote: ({ at, pitch }) => {
      stageAddition({
        at,
        pitch,
        channel: state.activeChannel,
        payloadIndex: state.notes.find((n) => n.channel === state.activeChannel)?.payloadIndex ?? 0,
        // A sixteenth of a bar is long enough to see and short enough not to
        // overlap the next beat; the player can drag the edge like any other note.
        durationTicks: Math.max(1, Math.round(state.tpb / 16)),
        velocity: 100,
      });
      afterEdit();
    },
  });
  lane = new VelocityLane(el.velane, {
    onEdit: (note, patch) => { stageEdit(note, patch); afterEdit(); },
    onSelect: (note) => { if (roll) roll.selected = note; },
    onSeek: (tick) => seekTo(tick),
    onCommit: afterEdit,
  });

  for (const view of [roll, lane]) {
    view.setNotes([], part(), timing);
  }
  // One place to repaint both, and the lane is slaved to the roll's scale.
  draw();
}

/**
 * Repaint and recount after a gesture.
 *
 * The views are re-fed the note list, not just repainted, because adding or removing
 * a note changes which notes there are. Rebuilding the list on every pointer move
 * would refit the roll mid-drag, so `fit` stays off here and the view keeps its
 * zoom - the player is in the middle of something.
 */
function afterEdit() {
  // Adding or removing changes which notes there are, so the views are re-fed -
  // but without refitting, or the notes would move under the pointer mid-gesture.
  if (state && (state.added.length || state.removed.size)) {
    setActivePart(state.activeChannel, { preserveView: true });
  }
  draw();
  refresh();
}

function mountMap() {
  mapView = new MapView(el.map, {
    onToggle: (section, channel, on) => stageCasm({ op: 'channel', section, channel, on }),
    onRename: (section, name) => stageCasm({ op: 'rename', section, name }),
    onRemove: (section) => stageCasm({ op: 'remove', section }),
    onClone: (after) => stageCasm({ op: 'clone', after }),
  });
  renderMap();
}

// ---- what plays when --------------------------------------------------------

/**
 * The variations, joined from the two halves of the file.
 *
 * The declared map says which parts each variation may use; the markers say when it
 * happens. Building both and comparing them is what turns "the file says Main D
 * uses Pad" into "and here is Main D, six bars long, with Pad sounding throughout".
 */
function currentVariations() {
  if (!state) return [];
  const casm = parseCasm(state.buffer);
  const spans = state.spans ?? [];
  if (!spans.length) return [];
  // buildVariations wants the same shape indexNotes returns.
  return buildVariations(
    { sectionSpans: spans, notes: state.notes, lengthTicks: state.lengthTicks },
    casm,
    { ticksPerBar: state.tpb },
  );
}

function renderVariations() {
  if (!state || !variationView) return;
  const variations = state.variations ?? [];
  if (!variations.length) {
    el.blockVariations.classList.add('hidden');
    return;
  }
  el.blockVariations.classList.remove('hidden');
  variationView.selected = state.variationIndex;
  variationView.render(variations, { ticksPerBar: state.tpb });

  const bars = variations.reduce((a, v) => a + v.bars, 0);
  el.variationsHint.textContent = `${variations.length} occurrence${variations.length === 1 ? '' : 's'}`
    + ` \u00b7 ${bars} bars \u00b7 in the order the style plays them`;
  const mismatched = variations.filter((v) => v.match === 'partial');
  const undeclared = variations.filter((v) => v.match === 'undeclared');
  const silent = variations.filter((v) => v.match === 'silent');
  const bits = [];
  if (undeclared.length) {
    bits.push(`${undeclared.length} variation${undeclared.length === 1 ? '' : 's'} not declared in the map (${undeclared.map((v) => v.name).join(', ')})`);
  }
  if (silent.length) {
    bits.push(`${silent.length} declared but silent here (${silent.map((v) => v.name).join(', ')})`);
  }
  if (mismatched.length) {
    bits.push(`${mismatched.length} where a declared part did not sound: `
      + mismatched.map((v) => `${v.name} (${v.missing.map((c) => `ch${c + 1}`).join(', ')})`).join('; '));
  }
  el.variationsSummary.innerHTML = bits.length
    ? `<b>Worth knowing:</b> ${esc(bits.join('. '))}.`
    : 'Every variation matches what the map declares.';
}

function mountVariations() {
  variationView = new VariationView(el.vars, {
    onSelect: (index) => {
      state.variationIndex = index;
      renderVariations();
      renderLift();
    },
  });
  renderVariations();
}

// ---- lifting one note -------------------------------------------------------

function mountLift() {
  noteLift = new NoteLift(el.lift, {
    parts: () => state.rows.map((r) => ({ channel: r.channel, label: r.label })),
    notes: () => state.notes,
    variations: () => state.variations ?? [],
    variationIndex: () => state.variationIndex,
    scope: () => state.liftScope,
    setScope: (value) => { state.liftScope = value; renderLift(); },
    ticksPerBar: () => state.tpb,
    current: (note) => effective(note).velocity,
    apply: (targets) => {
      for (const { note, velocity } of targets) stageEdit(note, { velocity });
      afterEdit();
      // The summary reads the notes through `effective`, so it has to be rebuilt
      // after the edits or it keeps describing the state before them.
      renderLift();
    },
  });
  renderLift();
}

function renderLift() {
  if (!state || !noteLift) return;
  noteLift.render({
    parts: state.rows.map((r) => ({ channel: r.channel, label: r.label })),
    notes: state.notes,
    variations: state.variations ?? [],
  });
}

function draw() {
  if (!state || !roll || !lane) return;
  const overrides = velocityOverrides();
  const shape = shapeOverrides();
  roll.setOverrides(overrides);
  roll.setShapeOverrides(shape);
  lane.setOverrides(overrides);
  lane.setShapeOverrides(shape);
  lane.syncView(roll);
  roll.draw();
  lane.draw();
}

/** Velocity overrides for the part on screen, keyed the way both views expect. */
function velocityOverrides() {
  const map = new Map();
  if (!state) return map;
  for (const n of state.notes) {
    if (n.channel !== state.activeChannel) continue;
    const v = pendingVelocityOf(n);
    if (v !== null) map.set(n.velocityOffset, v);
  }
  return map;
}

/** Pending pitch and length for the part on screen. */
function shapeOverrides() {
  const map = new Map();
  if (!state) return map;
  for (const n of state.notes) {
    if (n.channel !== state.activeChannel) continue;
    const shape = pendingShapeOf(n);
    if (shape) map.set(n.velocityOffset, shape);
  }
  return map;
}

function renderPartSelect() {
  el.partSelect.textContent = '';
  for (const r of state.rows) {
    const o = document.createElement('option');
    o.value = String(r.channel);
    o.textContent = `${r.label} \u00b7 ch ${r.channel + 1}`;
    el.partSelect.append(o);
  }
  el.partSelect.value = String(state.activeChannel);
}

function setActivePart(channel, { fit = false, preserveView = false } = {}) {
  if (!state) return;
  state.activeChannel = Number(channel);
  el.partSelect.value = String(state.activeChannel);
  const row = state.rows.find((r) => r.channel === state.activeChannel) ?? null;
  // Notes that have been marked for removal are still shown - faded - so the player
  // can see what is leaving and change their mind. Excluding them would make a
  // removal invisible the moment it was made.
  const notes = state.notes.filter((n) => n.channel === state.activeChannel);
  // A staged addition has no parsed note behind it, so it is given the shape of one
  // for drawing: a negative velocityOffset cannot collide with a real note's, and
  // the roll keys its override maps by that, so a new note is drawn with its own
  // values rather than inheriting another note's pending edits.
  const shown = notes.concat(state.added
    .filter((a) => a.channel === state.activeChannel)
    .map((a, i) => ({
      at: a.at,
      note: a.pitch,
      velocity: a.velocity,
      durationTicks: a.durationTicks,
      channel: a.channel,
      velocityOffset: -(i + 1),
      added: true,
    })));
  roll?.setPending({ removed: state.removed, added: state.added });
  const timing = { division: state.division, ticksPerBar: state.tpb, lengthTicks: state.lengthTicks };
  const view = { name: row?.label ?? 'Part', family: row?.family ?? 'other', color: row?.hex ?? '#e8a33d' };

  // Normally a change of part refits, so the new part fills the screen. After adding
  // or removing a note it must not: that would move the notes out from under the
  // pointer that just did it, and the second click would land somewhere else.
  roll?.setNotes(shown, view, timing, { fit: !preserveView });
  lane?.setNotes(shown, view, timing, roll);
  roll.snap = lane.snap = Number(el.snap.value) || 0;
  if (fit) roll?.fit();
  lane?.syncView(roll);

  el.rollEmpty.classList.toggle('hidden', shown.length > 0);
  const pendingHere = notes.filter((n) => pendingVelocityOf(n) !== null || pendingShapeOf(n) !== null).length;
  const addedHere = shown.length - notes.length;
  el.editorHint.textContent = shown.length
    ? `${shown.length} notes`
      + (addedHere ? ` (${addedHere} new)` : '')
      + ` \u00b7 ${pendingHere ? `${pendingHere} edited` : 'no edits yet'}`
    : 'no notes';
  draw();
  refresh();
}

/** Scroll both views and the playback position to a tick. */
function seekTo(tick) {
  if (!state || !roll) return;
  roll.scrollTick = Math.max(0, Math.min(state.lengthTicks, tick - roll.cssWidth * 0.1 / roll.pxPerTick));
  roll.clampScroll();
  draw();
  if (player) player.start(Math.max(0, tickToSeconds(state.tempoMap, tick, state.division)));
}

// ---- the section map ---------------------------------------------------------

/**
 * The map as it would be written, which is the only version worth showing.
 *
 * Rendering the original parse and applying the staged edits separately would let
 * the two disagree, and the user would be looking at a map that is not the one in
 * the file they are about to download.
 *
 * A map that cannot be read is reported and then set aside. It is one feature
 * among several in this page, and a file whose section map is in a layout this
 * reader does not recognise must still load its notes - otherwise one odd style
 * makes the whole tool look broken.
 */
function currentMap() {
  if (!state) return { casm: null, parts: [], error: null };
  let result;
  try {
    result = casmWithEdits(state.buffer, state.casmOps);
  } catch (err) {
    state.casmError = err instanceof Error ? err.message : String(err);
    return { casm: null, parts: [], error: state.casmError };
  }
  state.casmError = result.reason ?? null;
  return { casm: result.casm, parts: result.casm ? styleParts(result.casm) : [], error: state.casmError };
}

function renderMap() {
  if (!state || !mapView) return;

  let live = null;
  try {
    live = parseCasm(state.buffer);
  } catch (err) {
    live = null;
    state.casmError = err instanceof Error ? err.message : String(err);
  }

  if (!live) {
    el.blockMap.classList.remove('hidden');
    el.mapHint.textContent = '';
    el.map.textContent = '';
    el.map.append(Object.assign(document.createElement('p'), {
      className: 'empty',
      textContent: state.casmError
        ? `This file's variation map could not be read: ${state.casmError}`
        : 'This file has no variation map. The note tools below still work on it.',
    }));
    el.mapSummary.textContent = '';
    return;
  }

  const { casm, parts } = currentMap();
  el.blockMap.classList.remove('hidden');

  mapView.render(casm, parts, { editable: true });

  const info = describeMap(live);
  el.mapHint.textContent = `${live.sections.length} variation${live.sections.length === 1 ? '' : 's'}`
    + ` \u00b7 ${parts.length} part${parts.length === 1 ? '' : 's'}`;
  const staged = state.casmOps.length;
  el.mapSummary.innerHTML = info.complete
    ? ''
    : `<b>Note:</b> ${esc(info.text)}`;
  if (staged) {
    el.mapSummary.innerHTML += `<br><b>${staged}</b> map change${staged === 1 ? '' : 's'} staged.`;
  }
  if (state.casmError) {
    el.mapSummary.innerHTML += `<br><b>Could not apply a change:</b> ${esc(state.casmError)}`;
  }
  // A map change alters what the variations are declared to contain, so the
  // variation list has to be rebuilt or its check marks would go stale.
  refreshVariations();
}

/**
 * Rebuild the variation list from the current map, keeping the selection.
 *
 * Rebuilding rather than patching matters: a deletion renumbers everything after
 * it, so an index held from before the edit would point at a different variation.
 */
function refreshVariations() {
  if (!state) return;
  const before = state.variations?.[state.variationIndex]?.name ?? null;
  state.variations = currentVariations();
  if (before) {
    const same = state.variations.findIndex((v) => v.name === before);
    if (same >= 0) state.variationIndex = same;
  }
  if (state.variationIndex >= state.variations.length) {
    state.variationIndex = Math.max(0, state.variations.length - 1);
  }
  renderVariations();
}

/** Stage a map operation, then redraw. Nothing is written until download. */
function stageCasm(operation) {
  if (!state) return;

  if (operation.op === 'channel') {
    // One operation per cell, holding the state the user asked for. Appending
    // instead would make a second click on the same dot a second operation rather
    // than a reversal, and - worse - switching off a part that was already on by
    // default would store "off" as if it were an edit, when the file already says
    // off and there is nothing to write.
    const at = state.casmOps.findIndex(
      (o) => o.op === 'channel' && o.section === operation.section && o.channel === operation.channel,
    );
    if (at >= 0) state.casmOps[at] = operation;
    else state.casmOps.push(operation);
    pruneCasmOps();
  } else {
    state.casmOps.push(operation);
  }

  renderMap();
  refresh();
}

/**
 * Drop map operations that agree with the file as it already is.
 *
 * Without this, switching a part off and then on again would leave two operations
 * behind that cancel out. The download would still be correct - they would be
 * replayed in order - but the page would claim there were two pending edits when
 * the file is byte-for-byte the original, and Revert would have something to undo
 * that was never a change.
 */
function pruneCasmOps() {
  const original = parseCasm(state.buffer);
  if (!original) return;
  state.casmOps = state.casmOps.filter((op) => {
    if (op.op !== 'channel') return true;
    const section = original.sections.find((s) => s.name === op.section);
    // A cell whose section has been renamed or deleted cannot be compared, so it
    // is kept and left for the writer to resolve.
    if (!section) return true;
    return section.channels.includes(op.channel) !== op.on;
  });
}

// ---- panels -----------------------------------------------------------------

function renderMeta() {
  const s = state;
  const bpm = 60000000 / (s.tempoMap[0]?.usPerQuarter ?? 500000);
  const secs = tickToSeconds(s.tempoMap, s.lengthTicks, s.division);
  const used = s.rows.map((r) => `ch${r.channel + 1}`).join(', ');
  el.fileName.textContent = s.name;
  el.fileMeta.textContent =
    `${s.version}${s.container === 'bare-smf' ? ' (no SFF container)' : ''} \u00b7 ${formatBytes(s.buffer.byteLength)} \u00b7 ` +
    `${s.payloads.map((p) => p.kind).join(' + ')} \u00b7 ${s.notes.length} notes \u00b7 ${bpm.toFixed(1)} BPM \u00b7 ` +
    `${s.meter.numerator}/${s.meter.denominator} \u00b7 ${s.meter.bars} bars \u00b7 ${secs.toFixed(1)}s \u00b7 ${used}`;
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
  // The variation ruler comes from the file's markers. It used to be inferred from
  // where the sounding parts changed, which invented boundaries where a variation
  // held steady and missed repeats of a layout another variation already used.
  const marked = state.variations ?? [];
  for (const v of marked) {
    const d = document.createElement('div');
    d.className = 'tl-block';
    d.style.flex = String(Math.max(1, v.bars));
    d.textContent = v.bars >= 3 ? v.name : '';
    d.title = `${v.name}: ${v.bars} bar(s), ${v.notes} note(s)`;
    blockWrap.append(d);
  }
  if (marked.length === 0) {
    const d = document.createElement('div');
    d.className = 'tl-block';
    d.style.flex = '1';
    d.textContent = state.notes.length ? 'no variation markers' : 'no notes';
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

  const inferred = false;
  const notes = [
    s.variations?.length
      ? `${s.variations.length} variations, read from the file's markers.`
      : 'This file carries no variation markers, so the blocks above are inferred from where the parts change.',
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
  const busiest = Math.max(...state.rows.map((x) => x.count));
  for (const r of state.rows) {
    const row = document.createElement('div');
    const on = state.selected.has(r.channel);
    row.className = 'voice' + (on ? '' : ' off') + (r.channel === state.activeChannel ? ' active' : '');
    row.style.setProperty('--lane', laneColor(r.family));
    row.dataset.channel = String(r.channel);
    row.setAttribute('role', 'checkbox');
    row.setAttribute('tabindex', '0');
    row.setAttribute('aria-checked', String(on));
    const avg = r.velSum / r.count;
    row.innerHTML =
      `<div class="voice-name"><span>${esc(r.label)}</span></div>` +
      `<div class="voice-ch">ch ${r.channel + 1}</div>` +
      `<div class="voice-pitch">${noteName(r.low)}\u2013${noteName(r.high)}<div class="bar-mini"><i style="width:${Math.min(100, (r.count / busiest) * 100).toFixed(0)}%"></i></div></div>` +
      `<div class="voice-vel">vel <b>${r.velMin}\u2013${r.velMax}</b> \u00b7 avg ${avg.toFixed(0)}</div>`;
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
  el.declaredHint.textContent = `declared by the style \u00b7 ${s.structure.declaredSections.length} sections`;
}

// ---- summary ----------------------------------------------------------------

/** Every note the bulk operations and the download would touch. */
function bulkTargetNotes() {
  if (!state) return [];
  return state.notes.filter((n) => isBulkTarget(n));
}

function refresh() {
  if (!state) return;
  const v = Number(el.velocity.value);
  el.velocityOut.textContent = String(v);
  for (const c of document.querySelectorAll('.chip[data-v]')) {
    c.setAttribute('aria-pressed', String(c.dataset.v === String(v)));
  }

  const total = pendingCount();
  const mapChanges = state.casmOps.length;
  el.btnRevert.disabled = total === 0 && mapChanges === 0 && state.bulkVelocity === null;
  el.editCount.textContent = total === 0 && mapChanges === 0 && state.bulkVelocity === null
    ? 'No pending edits'
    : [
      mapChanges ? `${mapChanges} map` : null,
      state.added.length ? `${state.added.length} added` : null,
      state.removed.size ? `${state.removed.size} removed` : null,
      state.pendingVelocity.size ? `${state.pendingVelocity.size} velocity` : null,
      state.pendingShape.size ? `${state.pendingShape.size} pitch/length` : null,
    ].filter(Boolean).join(' \u00b7 ');

  // The selection, not the part on screen: the bulk controls and the download
  // both work across every included part.
  const chosen = bulkTargetNotes();
  const bulkWrites = state.bulkVelocity !== null
    && chosen.some((n) => (pendingVelocityOf(n) ?? n.velocity) !== clampVelocity(v));
  el.btnDownload.disabled = chosen.length === 0 && total === 0 && !bulkWrites && mapChanges === 0;
  el.saveHint.textContent = mapChanges
    ? `${mapChanges} variation-map change${mapChanges === 1 ? '' : 's'} will be written into the download`
    : 'Your original file is never modified';

  if (chosen.length === 0) {
    el.summary.innerHTML = '<b>No notes match</b> - include a part or widen the pitch range.';
    return;
  }
  const distinct = [...new Set(chosen.map((n) => n.note))].sort((a, b) => a - b);
  const now = chosen.map((n) => pendingVelocityOf(n) ?? n.velocity);
  const orig = chosen.map((n) => n.velocity);
  const changed = now.filter((x, i) => x !== orig[i]).length;
  const parts = [...new Set(chosen.map((n) => n.channel))].length;
  const preview = distinct.slice(0, 12).map((n) => noteName(n)).join(', ');
  const more = distinct.length > 12 ? ` +${distinct.length - 12} more` : '';
  el.summary.innerHTML =
    `<b>${chosen.length}</b> notes in <b>${parts}</b> part(s), ${distinct.length} pitches (${preview}${more})<br>` +
    `Velocity now ${Math.min(...now)}\u2013${Math.max(...now)}, avg ${(now.reduce((a, b) => a + b, 0) / now.length).toFixed(1)} ` +
    `(was ${Math.min(...orig)}\u2013${Math.max(...orig)}) \u00b7 ${changed} changed.`;
}

// ---- operations -------------------------------------------------------------

function runOperation(kind) {
  if (!state) return;
  const notes = editableNotes();
  if (!notes.length) {
    say('No notes in this part and pitch range.', 'warn');
    return;
  }
  // Curve is positional, so it needs each note's place in the part's span.
  const span = Math.max(1, state.lengthTicks);
  const rng = mulberry32(0x5eed);

  for (const n of notes) {
    const from = effective(n).velocity;
    let next = from;
    if (kind === 'set') next = Number(el.velocity.value);
    else if (kind === 'scale') next = scaleVelocity(from, Number(el.opScale.value));
    else if (kind === 'offset') next = offsetVelocity(from, Number(el.opOffset.value));
    else if (kind === 'humanize') next = humanizeVelocity(from, Number(el.opHuman.value), rng);
    else if (kind === 'random') {
      const lo = Math.min(Number(el.opRandLow.value), Number(el.opRandHigh.value));
      const hi = Math.max(Number(el.opRandLow.value), Number(el.opRandHigh.value));
      next = randomVelocity(from, lo, hi, rng);
    } else if (kind === 'curve') {
      next = curveVelocity(from, n.at / span, Number(el.opCurvePivot.value),
        Number(el.opCurveBelow.value), Number(el.opCurveAbove.value));
    } else if (kind === 'accent') {
      next = accentVelocity(from, Number(el.opAccentAbove.value), Number(el.opAccentBy.value));
    }
    if (next !== from) stageEdit(n, { velocity: next });
  }
  draw();
  refresh();
  say(`${kind} applied to ${notes.length} notes in ${state.rows.find((r) => r.channel === state.activeChannel)?.label ?? 'this part'}.`, 'ok');
}

/** A seeded generator, so "humanize" is reproducible and can be undone by re-running. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- writing ----------------------------------------------------------------

/**
 * Fold the pending edits into a new buffer.
 *
 * Three passes, in this order, and the order is the whole trick. Pitch and length
 * re-emit tracks and shift every byte after them, which would invalidate the
 * offsets the later passes need. So the structural note edits go in first, then
 * the section map, and each pass re-reads the file to get fresh offsets before the
 * next one runs. Velocity goes last because it is the only pass that writes
 * individual bytes at remembered positions.
 *
 * CASM sits after the tracks in these files, so a note-length edit moves it. That
 * is why the map is re-parsed here rather than reusing the parse the edits were
 * staged against.
 *
 * @returns {ArrayBuffer}
 */
function buildEdited() {
  let buffer = state.buffer;

  // Adding and removing both re-emit a track, so they go in the same pass as the
  // length edits - a track is written once with every change to it, not once per
  // kind of change.
  const structural = state.pendingShape.size > 0
    || state.removed.size > 0
    || state.added.length > 0;

  if (structural) {
    // Later payloads first: rewriting one changes the length of everything after
    // it, so going backwards keeps the offsets from the original parse valid.
    const touched = state.notes.filter((n) => state.pendingShape.has(noteKey(n)) || isRemoved(n));
    const indices = [...new Set([
      ...touched.map((n) => n.payloadIndex),
      // An addition names the track to write to, which is not in the merged note
      // list at all, so its payload has to be asked for separately.
      ...state.added.map((a) => a.payloadIndex),
    ])].sort((a, b) => b - a);

    for (const payloadIndex of indices) {
      const entry = state.parsedByPayload[payloadIndex];
      if (!entry) continue;
      const notes = state.notes.filter(
        (n) => n.payloadIndex === payloadIndex && state.pendingShape.has(noteKey(n)),
      );
      const edits = notes.map((n) => ({ note: n, ...state.pendingShape.get(noteKey(n)) }));

      for (const note of state.notes.filter((n) => n.payloadIndex === payloadIndex && isRemoved(n))) {
        edits.push({ note, remove: true });
      }

      // Each addition goes to the track of the part it was made in - a note belongs
      // to the channel it plays, and the channel's track is where the file keeps it.
      for (const add of state.added.filter((a) => a.payloadIndex === payloadIndex)) {
        const trackIndex = entry.parsed.trackList.findIndex(
          (t) => t.events.some((ev) => ev.kind === 'note-on' && ev.bytes[0] === (0x90 | (add.channel & 0x0f))),
        );
        // A channel with no existing note-on has no track to add to, and putting
        // the note on an unrelated track would play it on the wrong channel.
        edits.push({
          add: {
            track: trackIndex >= 0 ? trackIndex : 0,
            at: add.at,
            pitch: add.pitch,
            velocity: add.velocity,
            durationTicks: add.durationTicks,
          },
        });
      }

      const clashes = findCollisions(entry.parsed, edits);
      if (clashes.length) {
        say(`${clashes.length} note pair(s) now overlap on the same pitch. Saving anyway \u2014 check the result in an arranger.`, 'warn');
      }
      buffer = applyEdits(buffer, entry.descriptor, entry.parsed, edits);
    }
  }

  if (state.casmOps.length > 0) {
    // Re-parsed from the current buffer, because the pass above may have moved it.
    let casm = null;
    try {
      casm = parseCasm(buffer);
    } catch (err) {
      casm = null;
      say(`The variation map could not be read, so the map changes were left out: ${err.message}`, 'warn');
    }
    if (!casm) {
      say('This file has no variation map, so the map changes cannot be written.', 'warn');
    } else {
      const applied = applyCasmOperations(casm, state.casmOps);
      if (!applied.ok) {
        say(`Stopped before writing: ${applied.reason}`, 'warn');
      } else {
        buffer = writeCasm(buffer, casm);
      }
    }
  }

  if (state.pendingVelocity.size > 0 || state.bulkVelocity !== null) {
    // Fresh offsets, because the passes above may have moved every byte.
    const fresh = parseAll(buffer);
    const byKey = new Map(fresh.notes.map((n) => [noteKey(n), n]));
    const targets = [];
    for (const n of state.notes) {
      const key = noteKey(n);
      const wanted = state.bulkVelocity !== null && isBulkTarget(n)
        ? clampVelocity(state.bulkVelocity)
        : state.pendingVelocity.get(key);
      if (wanted === null || wanted === undefined) continue;
      const target = byKey.get(key);
      if (target && wanted !== target.velocity) {
        targets.push({ velocityOffset: target.velocityOffset, velocity: wanted });
      }
    }
    if (targets.length) buffer = applyVelocities(buffer, targets);
  }

  return buffer;
}

/** Whether a note is inside the bulk operation's part set and pitch range. */
function isBulkTarget(n) {
  if (!state.selected.has(n.channel)) return false;
  const lo = Math.min(Number(el.noteLow.value), Number(el.noteHigh.value));
  const hi = Math.max(Number(el.noteLow.value), Number(el.noteHigh.value));
  return n.note >= lo && n.note <= hi;
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

const editedName = () => state.name.replace(/\.sty$/i, '') + '-edit.sty';

// ---- presets ----------------------------------------------------------------

function readPresets() {
  try {
    const raw = localStorage.getItem(PRESET_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    // A corrupt or unreadable store must not take the editor down with it.
    return [];
  }
}

function writePresets(list) {
  try {
    localStorage.setItem(PRESET_KEY, JSON.stringify(list));
  } catch {
    say('Could not write to this browser\u2019s local storage, so presets will not persist.', 'warn');
  }
}

function renderPresets() {
  const list = readPresets();
  el.presetList.textContent = '';
  if (!list.length) {
    el.presetList.innerHTML = '<p class="empty">No presets saved yet.</p>';
    return;
  }
  for (const preset of list) {
    const chip = document.createElement('span');
    chip.className = 'preset-item';
    const apply = document.createElement('button');
    apply.className = 'btn btn-sm';
    apply.textContent = preset.name;
    apply.title = `${preset.velocity?.size ?? 0} velocity, ${preset.shape?.length ?? 0} pitch/length`;
    apply.addEventListener('click', () => applyPreset(preset));
    const drop = document.createElement('button');
    drop.className = 'btn btn-sm btn-ghost';
    drop.textContent = '\u00d7';
    drop.title = 'Delete';
    drop.addEventListener('click', () => {
      writePresets(readPresets().filter((p) => p.name !== preset.name));
      renderPresets();
    });
    chip.append(apply, drop);
    el.presetList.append(chip);
  }
}

function applyPreset(preset) {
  if (!state) return;
  state.pendingVelocity = new Map(preset.velocity ?? []);
  state.pendingShape = new Map(preset.shape ?? []);
  state.bulkVelocity = null;
  setActivePart(state.activeChannel);
  say(`Applied preset "${preset.name}".`, 'ok');
}

function savePreset() {
  if (!state) return;
  const name = el.presetName.value.trim() || `preset ${readPresets().length + 1}`;
  const list = readPresets().filter((p) => p.name !== name);
  list.push({
    name,
    // Stored as plain arrays: a Map does not survive JSON, and these are the
    // values the download path needs anyway.
    velocity: [...state.pendingVelocity],
    shape: [...state.pendingShape],
    channel: state.activeChannel,
  });
  writePresets(list);
  el.presetName.value = '';
  renderPresets();
  say(`Saved preset "${name}" to this browser.`, 'ok');
}

// ---- playback ---------------------------------------------------------------

async function ensureAudio() {
  if (!audioCtx) {
    const Ctor = window.AudioContext ?? window.webkitAudioContext;
    audioCtx = new Ctor();
  }
  if (audioCtx.state === 'suspended') await audioCtx.resume();
  return audioCtx;
}

async function play(usePreview, fromSeconds = 0) {
  if (!state) return;
  const ctx = await ensureAudio();
  if (!player) player = new Player(ctx);

  const familyOf = (n) => (state.rows.find((r) => r.channel === n.channel)?.family) ?? 'other';
  const useEdit = usePreview && el.previewEdit.checked;
  const valueOf = (n) => (useEdit ? effective(n) : { velocity: n.velocity });

  // Only schedule notes that are audible: a part toggled off should go silent,
  // which is what makes a row a usable auditioning control.
  const audible = state.notes.filter((n) => state.selected.has(n.channel));

  player.load(audible, { tempoMap: state.tempoMap, timeSignature: state.timeSignature, division: state.division },
    (t) => tickToSeconds(state.tempoMap, t, state.division), familyOf, valueOf);
  player.setSpeed(Number(el.speed.value));
  player.master.gain.value = Number(el.volume.value) / 100;
  player.onEnded = () => {
    el.btnPlay.textContent = PLAY_LABEL;
    cancelAnimationFrame(rafId);
    roll?.setPlayhead(null);
    lane?.setPlayhead(null);
    draw();
  };
  player.start(fromSeconds);
  el.btnPlay.textContent = PAUSE_LABEL;
  tickPlayhead();
}

/** Current playback position as a tick, so both canvases can show it. */
function playheadTick() {
  if (!player?.playing || !state) return null;
  const secs = player.position();
  // Walk the tempo map backwards to the tick that matches this many seconds.
  const ticks = [];
  for (let t = 0; t <= state.lengthTicks; t += Math.max(1, Math.round(state.tpb / 4))) {
    ticks.push(t);
  }
  let lo = 0;
  let hi = ticks.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (tickToSeconds(state.tempoMap, ticks[mid], state.division) < secs) lo = mid + 1;
    else hi = mid;
  }
  return ticks[lo];
}

function stopPlayback() {
  player?.stop();
  el.btnPlay.textContent = PLAY_LABEL;
  cancelAnimationFrame(rafId);
  const ph = document.querySelector('.tl-playhead');
  ph?.remove();
  roll?.setPlayhead(null);
  lane?.setPlayhead(null);
  if (state) draw();
  el.clock.textContent = '0.0s';
}

function tickPlayhead() {
  if (!player?.playing || !state) return;
  const secs = player.position();
  el.clock.textContent = `${secs.toFixed(1)}s`;

  const tick = playheadTick();
  roll?.setPlayhead(tick);
  lane?.setPlayhead(tick);
  if (el.followPlay.checked && roll && tick !== null) roll.revealTick(tick);
  lane?.syncView(roll);
  roll?.draw();
  lane?.draw();

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

// ---- events -----------------------------------------------------------------

el.file.addEventListener('change', (e) => loadFile(e.target.files?.[0]));
el.drop.addEventListener('dragover', (e) => e.preventDefault());
el.drop.addEventListener('drop', (e) => { e.preventDefault(); loadFile(e.dataTransfer?.files?.[0]); });

el.btnReset.addEventListener('click', () => {
  stopPlayback();
  state = null;
  roll = null;
  lane = null;
  mapView = null;
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
  renderVoices();
  refresh();
  // One click toggles inclusion; double-click brings the part on screen, which is
  // the distinction worth keeping given the roll only ever shows one part.
});
el.voices.addEventListener('dblclick', (e) => {
  const row = e.target.closest('.voice');
  if (!row || !state) return;
  setActivePart(Number(row.dataset.channel), { fit: true });
});
el.voices.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.target.click(); }
});

el.partSelect.addEventListener('change', () => setActivePart(el.partSelect.value, { fit: true }));
el.snap.addEventListener('change', () => {
  const value = Number(el.snap.value) || 0;
  if (roll) roll.snap = value;
  if (lane) lane.snap = value;
});
el.btnFit.addEventListener('click', () => { roll?.fit(); draw(); });
el.followPlay.addEventListener('change', () => { if (state) draw(); });

el.btnRevert.addEventListener('click', () => {
  if (!state) return;
  state.pendingVelocity.clear();
  state.pendingShape.clear();
  state.removed.clear();
  state.added.length = 0;
  state.casmOps.length = 0;
  state.casmError = null;
  state.bulkVelocity = null;
  renderMap();
  setActivePart(state.activeChannel);
  say('Pending edits discarded. The file in memory is untouched.', 'ok');
});

el.btnCopyMap.addEventListener('click', async () => {
  if (!state || !mapView) return;
  const text = mapView.toText();
  try {
    await navigator.clipboard.writeText(text);
    say('The variation map is on the clipboard.', 'ok');
  } catch {
    // Clipboard access needs a secure context and permission; a download always
    // works, so offer that rather than failing silently.
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${state.name.replace(/\.sty$/i, '')}-map.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
});

el.noteLow.addEventListener('change', refresh);
el.noteHigh.addEventListener('change', refresh);
// Touching the slider is what declares a bulk edit. Until then it is just a value
// sitting in a control, and the download ignores it.
el.velocity.addEventListener('input', () => {
  if (state) state.bulkVelocity = Number(el.velocity.value);
  refresh();
});
for (const chip of document.querySelectorAll('.chip[data-v]')) {
  chip.addEventListener('click', () => {
    el.velocity.value = chip.dataset.v;
    if (state) state.bulkVelocity = Number(chip.dataset.v);
    refresh();
  });
}
el.btnApplySet.addEventListener('click', () => {
  if (state) state.bulkVelocity = Number(el.velocity.value);
  runOperation('set');
});
for (const button of document.querySelectorAll('[data-op]')) {
  button.addEventListener('click', () => runOperation(button.dataset.op));
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
  const map = state.casmOps.length;
  const notes = pendingCount();
  try {
    download(buildEdited(), editedName());
    const parts = [
      map ? `${map} map change${map === 1 ? '' : 's'}` : null,
      notes ? `${notes} note edit${notes === 1 ? '' : 's'}` : null,
      state.bulkVelocity !== null ? `velocity set to ${el.bulkVelocity}` : null,
    ].filter(Boolean);
    // Saying "velocity set to 100" when nothing was pending would be a lie the
    // user could check by loading the file and hearing no difference.
    say(parts.length
      ? `Wrote ${parts.join(' and ')} into ${editedName()}.`
      : `No changes to write, so ${editedName()} is a copy of the original.`, 'ok');
  } catch (err) {
    say(`Could not write the file: ${err?.message ?? err}`, 'warn');
  }
});
el.btnDownloadOrig.addEventListener('click', () => state && download(state.buffer.slice(0), state.name));

el.btnPresetSave.addEventListener('click', savePreset);
renderPresets();

el.btnJsonExport.addEventListener('click', () => {
  if (!state) return;
  const payload = {
    format: 'yamaha-style-velocity-editor',
    version: 1,
    source: state.name,
    part: state.rows.find((r) => r.channel === state.activeChannel)?.label ?? null,
    channel: state.activeChannel,
    notes: state.notes
      .filter((n) => pendingVelocityOf(n) !== null || pendingShapeOf(n) !== null)
      .map((n) => {
        const e = effective(n);
        const out = { channel: n.channel + 1, track: n.track, tick: n.at, pitch: e.pitch };
        if (pendingVelocityOf(n) !== null) out.velocity = e.velocity;
        if (pendingShapeOf(n)?.durationTicks !== undefined) out.lengthTicks = e.durationTicks;
        return out;
      }),
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = state.name.replace(/\.sty$/i, '') + '-edits.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  say(`Exported ${payload.notes.length} edited note(s) as JSON.`, 'ok');
});

el.btnJsonImport.addEventListener('click', () => el.jsonFile.click());
el.jsonFile.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file || !state) return;
  try {
    const data = JSON.parse(await file.text());
    if (data.format !== 'yamaha-style-velocity-editor') {
      throw new Error('That JSON is not an edit file from this tool.');
    }
    // Match on the human-facing numbers, so a sidecar still applies after the
    // file itself has been re-saved.
    const index = new Map(state.notes.map((n) => [`${n.channel}:${n.at}:${n.note}`, n]));
    let hits = 0;
    for (const entry of data.notes ?? []) {
      const note = index.get(`${(entry.channel ?? 1) - 1}:${entry.tick}:${entry.pitch}`);
      if (!note) continue;
      const patch = {};
      if (entry.velocity !== undefined) patch.velocity = entry.velocity;
      if (entry.lengthTicks !== undefined) patch.durationTicks = entry.lengthTicks;
      if (Object.keys(patch).length) {
        stageEdit(note, patch);
        hits++;
      }
    }
    setActivePart(state.activeChannel);
    say(`Imported ${hits} of ${(data.notes ?? []).length} entries from JSON.`, hits ? 'ok' : 'warn');
  } catch (err) {
    say(`Could not read that JSON: ${err?.message ?? err}`, 'warn');
  } finally {
    el.jsonFile.value = '';
  }
});

window.addEventListener('resize', () => {
  if (!state || !roll || !lane) return;
  roll.resize();
  lane.resize();
  draw();
});

/**
 * A read-only handle on the canvas geometry, for the browser tests.
 *
 * The roll and the lane know the only mapping from a note to a pixel, and a test
 * that recomputed it would be a second implementation to keep in step - it would
 * pass against a broken view. This exposes that mapping and nothing else: no
 * state, no setters, so a test cannot quietly drive the editor instead of
 * exercising it.
 */
window.__editor = {
  part: () => state?.rows.find((r) => r.channel === state?.activeChannel)?.label ?? null,
  pending: () => pendingCount(),
  bulkVelocity: () => state?.bulkVelocity ?? null,
  notes: () => state?.rows.map((r) => ({ label: r.label, channel: r.channel })) ?? [],
  /** The first note of the part on screen, in both ticks and pixels. */
  first: () => {
    const n = roll?.notes?.[0];
    if (!n || !roll) return null;
    // The drawn values, not the file's: after a pending edit these differ, and a
    // test asking "what does the screen show" must not be answered from the parse.
    const pitch = roll.pitchOf(n);
    const ticks = roll.durationOf(n);
    return {
      at: n.at, channel: n.channel, pitch, velocity: roll.velocityOf(n), durationTicks: ticks,
      filePitch: n.note, fileVelocity: n.velocity, fileDurationTicks: n.durationTicks,
      x: roll.tickToX(n.at), y: roll.pitchToY(pitch),
      width: Math.max(3, ticks * roll.pxPerTick),
      // The drawn row height, so a test aims at the middle of the note rather
      // than reimplementing the -1px gap the renderer leaves between rows.
      height: Math.max(2, roll.pxPerSemitone - 1),
      // Pixels per semitone, for a test that has to move by a number of semitones
      // rather than by a fixed distance - the row height depends on how tall the
      // part is, so a hardcoded drag length is right for one fixture and wrong for
      // the next.
      rowHeight: roll.pxPerSemitone,
    };
  },
  /** Where the velocity lane draws a given value. */
  laneY: (velocity) => (lane ? lane.velocityToY(velocity) : 0),
  width: () => roll?.cssWidth ?? 0,
  /** How many notes the roll is showing, additions included. */
  visibleNotes: () => roll?.notes?.length ?? 0,
  /** The notes marked for removal, as count-and-identity rather than as note objects. */
  removed: () => (state ? [...state.removed].map((n) => ({ at: n.at, pitch: n.note, velocity: n.velocity })) : []),
  /**
   * An empty spot in the part to double-click, in canvas pixels.
   *
   * Picked from the roll's own geometry rather than hard-coded, because a row's
   * height depends on the pitch range of the part and a fixed offset would land on
   * the wrong row for one fixture and the right one for the next.
   */
  addPoint: () => {
    if (!roll?.notes?.length || !state) return null;
    // Below the lowest note in the part: nothing is drawn there, so a double-click
    // lands on empty space rather than on an existing note. Only if there is room
    // below - a part that already sits on the lowest pitch uses the row above.
    const lowest = Math.min(...roll.notes.map((n) => roll.pitchOf(n)));
    const pitch = lowest > 0 ? lowest - 1 : Math.min(127, Math.max(...roll.notes.map((n) => roll.pitchOf(n))) + 1);
    const first = roll.notes[0];
    return {
      pitch,
      // Past the note's right edge, so the click cannot land on its own body.
      x: roll.tickToX(first.at + roll.durationOf(first)) + 8,
      y: roll.pitchToY(pitch) + roll.pxPerSemitone / 2,
    };
  },
};

// The pitch range the bulk operations work over. Without this the two selects are
// empty, Number('') is 0, and every range collapses to "pitch 0 only" - so the bulk
// operations silently have nothing to act on.
fillNotes();