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
  NOTE_CLASSES, CHORD_TYPES, RETRIGGER_RULES,
} from './cseg.js';
import { MapView, describeMap } from './map-view.js';
import { VariationView } from './variation-view.js';
import { buildVariations } from './variations.js';
import { NoteLift } from './note-lift.js';
import { t, cnt, initLang, setLang, getLang, applyI18n, secKey } from './i18n.js';

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
  blockPartDetails: $('blockPartDetails'), pdSection: $('pdSection'), pdPart: $('pdPart'),
  pdFields: $('pdFields'), pdSummary: $('pdSummary'),
  vars: $('vars'), variationsHint: $('variationsHint'), variationsSummary: $('variationsSummary'),
  blockVariationPlay: $('blockVariationPlay'), playVariation: $('playVariation'),
  playLoop: $('playLoop'), playCountIn: $('playCountIn'),
  btnPlayVariation: $('btnPlayVariation'), playVariationHint: $('playVariationHint'),
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
  btnLang: $('btnLang'),
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
const PLAY_LABEL = () => t('btn_play');
const PAUSE_LABEL = () => t('btn_pause');

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

/** A tick as "bar 3" / "شريط 3", for saying where something happened. */
function barLabel(tick) {
  const n = !state ? 1 : Math.floor(tick / state.tpb) + 1;
  return t('bar_at', { n });
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
  say(t('note_added', { pitch: noteName(add.pitch), bar: barLabel(add.at) }), 'ok');
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
  say(t('note_removed', { pitch: noteName(note.note), bar: barLabel(note.at) }), 'ok');
}

/** Undo a removal, so a note brought back is the one that was there. */
function unstageRemoval(note) {
  if (!state.removed.delete(note)) return;
  say(t('note_restored', { pitch: noteName(note.note), bar: barLabel(note.at) }), 'ok');
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
    say(t('reading'));
    const buffer = await file.arrayBuffer();
    const parsed = parseAll(buffer);
    const { info, notes, payloads, parsedByPayload, tempoMap, timeSignature, division, lengthTicks, spans } = parsed;

    // Structure: CASM names the parts and declares the original sections.
    const structure = readStyleStructure(buffer);
    const stats = summariseByChannel(notes);

    // Anything the map reader could not make sense of is said out loud on load.
    // These bytes are kept rather than dropped, so a save does not damage the file -
    // but a player who is told nothing has no way to know the map is not complete,
    // and would not think to look for the difference.
    const casmForWarnings = parseCasm(buffer);
    const mapWarnings = (casmForWarnings?.sections ?? [])
      .flatMap((s) => (s.warnings ?? []).map((w) => `${s.name || 'a variation'}: ${w}`));

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
      say(t('loaded_partial', { a: skipped.map((p) => p.kind).join(' and '), b: payloads.filter((p) => p.ok).map((p) => p.kind).join(' and ') }), 'warn');
    } else if (mapWarnings.length) {
      say(t('loaded_mapwarn', { n: notes.length, w: mapWarnings.join('; ') }), 'warn');
    } else {
      say(t('loaded_ok', { n: notes.length }), 'ok');
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
  el.variationsHint.textContent = t('varswhen_hint_line', {
    occ: cnt(variations.length, 'occurrence'),
    bars: cnt(bars, 'bar'),
  });
  const mismatched = variations.filter((v) => v.match === 'partial');
  const undeclared = variations.filter((v) => v.match === 'undeclared');
  const silent = variations.filter((v) => v.match === 'silent');
  const bits = [];
  if (undeclared.length) {
    bits.push(t('varswhen_undeclared', { n: cnt(undeclared.length, 'variation'), names: undeclared.map((v) => v.name).join(', ') }));
  }
  if (silent.length) {
    bits.push(t('varswhen_silent', { n: cnt(silent.length, 'variation'), names: silent.map((v) => v.name).join(', ') }));
  }
  if (mismatched.length) {
    bits.push(t('varswhen_mismatch', {
      n: cnt(mismatched.length, 'variation'),
      detail: mismatched.map((v) => `${v.name} (${v.missing.map((c) => `ch${c + 1}`).join(', ')})`).join('; '),
    }));
  }
  el.variationsSummary.innerHTML = bits.length
    ? `<b>${esc(t('varswhen_worth'))}</b> ${esc(bits.join('. '))}.`
    : esc(t('varswhen_all_match'));
  renderPlayVariation();
}

/**
 * The list a variation can be played from, kept in step with the form above.
 *
 * Two entries per name where a name occurs twice - a style can play Main B in two
 * places - because they are two different stretches of music and playing one is not
 * playing the other. The number is which time it appears, so the list stays readable.
 */
function renderPlayVariation() {
  const variations = state?.variations ?? [];
  const previous = el.playVariation.value;
  el.playVariation.textContent = '';
  const seen = new Map();
  variations.forEach((v, index) => {
    const n = (seen.get(v.name) ?? 0) + 1;
    seen.set(v.name, n);
    const o = document.createElement('option');
    o.value = String(index);
    o.textContent = v.bars ? t('pvary_option', { name: v.name, n: cnt(v.bars, 'bar') }) : v.name;
    el.playVariation.append(o);
  });

  // Default to Main A, because that is where a player starts and it is what the
  // style leads with. Falls back to the first entry when there is no Main A.
  const mainA = variations.findIndex((v) => /^main a$/i.test(v.name.trim()));
  el.playVariation.value = variations.some((v) => String(v.index) === previous) ? previous
    : String(mainA >= 0 ? mainA : 0);
  el.blockVariationPlay.classList.toggle('hidden', variations.length === 0);
  describePlayVariation();
}

/**
 * Hand the engine the region, the loop and the count-in for whatever is selected.
 *
 * Applied whenever the selection changes rather than only when Play is pressed, so
 * the settings describe what is *about* to play. Otherwise the engine holds the
 * last played configuration, and a player who changes the count-in and reads the
 * status line is told about the previous one.
 */
function applyPlaySettings() {
  if (!player) return;
  const v = (state?.variations ?? [])[Number(el.playVariation.value)];
  player.setRegion(v ? { startTick: v.startTick, endTick: v.endTick } : null,
    v ? el.playLoop.checked : false);
  player.setCountIn(v ? Number(el.playCountIn.value) : 0, state.tpb);
}

/** What the button is about to play, in bars and seconds. */
function describePlayVariation() {
  applyPlaySettings();
  const variations = state?.variations ?? [];
  const v = variations[Number(el.playVariation.value)];
  if (!v) { el.playVariationHint.textContent = ''; return; }
  const bars = v.bars ?? Math.max(1, Math.round((v.endTick - v.startTick) / state.tpb));
  const secs = tickToSeconds(state.tempoMap, v.endTick, state.division)
    - tickToSeconds(state.tempoMap, v.startTick, state.division);
  const length = t('pvary_len', { bars: cnt(bars, 'bar'), secs: t('clock_s', { s: secs.toFixed(1) }) });

  // A variation that holds none of the parts currently switched on would play
  // silence, which looks like a broken button. Say so, and say why.
  const sounding = state.notes.filter(
    (n) => state.selected.has(n.channel) && n.at >= v.startTick && n.at < v.endTick,
  ).length;
  el.playVariationHint.textContent = sounding
    ? length
    : t('pvary_silent', { len: length });
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
    o.textContent = t('part_option', { label: r.label, ch: r.channel + 1 });
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
    ? t('editor_hint_line', {
      notes: cnt(shown.length, 'note'),
      extra: addedHere ? ` (${t('editor_hint_new', { n: addedHere })})` : '',
      pending: pendingHere ? t('editor_hint_edited', { n: pendingHere }) : t('editor_hint_noedits'),
    })
    : t('editor_hint_nonotes');
  draw();
  refresh();
}

/** Scroll both views and the playback position to a tick. */
function seekTo(tick) {
  if (!state || !roll) return;
  roll.scrollTick = Math.max(0, Math.min(state.lengthTicks, tick - roll.cssWidth * 0.1 / roll.pxPerTick));
  roll.clampScroll();
  draw();
  // A tick, not seconds: the player was handed a tick->seconds function and works
  // in seconds internally, so converting here meant seeking to the wrong place
  // whenever the tempo was not 120.
  if (player?.playing) player.start(Math.max(0, Math.round(tick)));
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
        ? t('map_unreadable', { err: state.casmError })
        : t('map_no_map_tools'),
    }));
    el.mapSummary.textContent = '';
    renderPartDetails();
    return;
  }

  const { casm, parts } = currentMap();
  el.blockMap.classList.remove('hidden');

  mapView.render(casm, parts, { editable: true });

  const info = describeMap(live);
  el.mapHint.textContent = t('map_hint_line', {
    vars: cnt(live.sections.length, 'variation'),
    parts: cnt(parts.length, 'part'),
  });
  const staged = state.casmOps.length;
  el.mapSummary.innerHTML = info.complete
    ? ''
    : `<b>${esc(t('map_note'))}</b> ${esc(info.text)}`;
  if (staged) {
    el.mapSummary.innerHTML += `<br>${esc(t('map_staged', { n: staged, s: staged === 1 ? '' : 's', c: cnt(staged, 'change') }))}`;
  }
  if (state.casmError) {
    el.mapSummary.innerHTML += `<br><b>${esc(t('map_apply_failed'))}</b> ${esc(state.casmError)}`;
  }
  // A map change alters what the variations are declared to contain, so the
  // variation list has to be rebuilt or its check marks would go stale.
  refreshVariations();
  renderPartDetails();
}

/**
 * Read one editable Ctb2 field for the details panel.
 * Range fields (low/middle/high) arrive as { range, sub } and read one sub-key.
 */
function pdRead(part, spec) {
  if (spec.range) return part[spec.range]?.[spec.sub];
  return part[spec.field];
}

/** The staged value shape setField understands: scalars, or a patch for ranges. */
function pdStageValue(spec, raw) {
  if (spec.range) return { [spec.sub]: Number(raw) };
  return Number(raw);
}

/** True when a staged field op actually differs from the file. */
function pdDiffers(part, field, value) {
  if (value !== null && typeof value === 'object') {
    const range = part[field];
    if (!range || typeof range !== 'object') return true;
    return Object.entries(value).some(([k, v]) => range[k] !== v);
  }
  return part[field] !== value;
}

/** One staged field op replaces another for the same cell, like channel dots. */
function stageFieldOp(section, channel, spec, raw) {
  stageCasm({ op: 'field', section, channel, field: spec.range ?? spec.field, value: pdStageValue(spec, raw) });
}

/** Ctb2 fields the details panel offers, in display order. */
const PD_FIELDS = [
  { field: 'destinationChannel', kind: 'channel', label: 'pdet_dest' },
  { field: 'chordKey', kind: 'pitchclass', label: 'pdet_chordkey' },
  { field: 'chordType', kind: 'chordtype', label: 'pdet_chordtype' },
  { field: 'middleLow', kind: 'byte', label: 'pdet_midlow' },
  { field: 'middleHigh', kind: 'byte', label: 'pdet_midhigh' },
  { range: 'middle', sub: 'retrigger', kind: 'retrigger', label: 'pdet_retrigger' },
];

let pdSectionName = null;
let pdChannel = null;

function pdSelect(labelText, id, options, current, onPick) {
  const wrap = document.createElement('label');
  wrap.className = 'inline';
  const span = document.createElement('span');
  span.textContent = labelText;
  const sel = document.createElement('select');
  sel.id = id;
  for (const [value, text] of options) {
    const o = document.createElement('option');
    o.value = String(value);
    o.textContent = text;
    sel.append(o);
  }
  sel.value = String(current);
  sel.addEventListener('change', () => onPick(sel.value));
  wrap.append(span, sel);
  return wrap;
}

function pdNumber(labelText, id, value, lo, hi, onPick) {
  const wrap = document.createElement('label');
  wrap.className = 'inline';
  const span = document.createElement('span');
  span.textContent = labelText;
  const input = document.createElement('input');
  input.type = 'text';
  input.inputMode = 'numeric';
  input.id = id;
  input.value = String(value ?? '');
  // Stage on change, not on every keystroke: halfway through "127" the field
  // reads "12", and that is not a value anyone asked to write.
  input.addEventListener('change', () => {
    const n = Math.max(lo, Math.min(hi, Math.round(Number(input.value))));
    if (!Number.isFinite(n)) {
      renderPartDetails();
      return;
    }
    input.value = String(n);
    onPick(n);
  });
  wrap.append(span, input);
  return wrap;
}

/**
 * The Ctb2 fields behind one map cell, editable.
 *
 * Values shown are the staged ones (currentMap replays casmOps), so the panel
 * never disagrees with the download. Nothing writes until download: every
 * change stages a {op:'field'} operation next to the dot toggles.
 */
function renderPartDetails() {
  const box = el.blockPartDetails;
  if (!box) return;
  const { casm } = currentMap();
  if (!state || !casm || !casm.sections.length) {
    box.classList.add('hidden');
    return;
  }
  box.classList.remove('hidden');

  const section = casm.sections.find((s) => s.name === pdSectionName) ?? casm.sections[0];
  pdSectionName = section.name;
  const part = section.parts.find((p) => p.channel === pdChannel) ?? section.parts[0];
  if (!part) {
    el.pdFields.textContent = '';
    el.pdSummary.textContent = t('mv_no_parts');
    return;
  }
  pdChannel = part.channel;

  el.pdSection.textContent = '';
  el.pdSection.append(...casm.sections.map((s) => {
    const o = document.createElement('option');
    o.value = s.name;
    o.textContent = s.name;
    return o;
  }));
  el.pdSection.value = section.name;
  el.pdSection.onchange = () => {
    pdSectionName = el.pdSection.value;
    pdChannel = null;
    renderPartDetails();
  };

  el.pdPart.textContent = '';
  el.pdPart.append(...section.parts.map((p) => {
    const o = document.createElement('option');
    o.value = String(p.channel);
    o.textContent = t('part_option', { label: p.name, ch: p.channel + 1 });
    return o;
  }));
  el.pdPart.value = String(part.channel);
  el.pdPart.onchange = () => {
    pdChannel = Number(el.pdPart.value);
    renderPartDetails();
  };

  el.pdFields.textContent = '';
  for (const spec of PD_FIELDS) {
    const current = pdRead(part, spec);
    const pick = (raw) => stageFieldOp(section.name, part.channel, spec, raw);
    if (spec.kind === 'channel') {
      el.pdFields.append(pdSelect(t(spec.label), `pd-${spec.field}`,
        Array.from({ length: 16 }, (_, i) => [i, `ch ${i + 1}`]), current ?? 0, (v) => pick(Number(v))));
    } else if (spec.kind === 'pitchclass') {
      el.pdFields.append(pdSelect(t(spec.label), `pd-${spec.field}`,
        NOTE_CLASSES.map((n, i) => [i, n]), current ?? 0, (v) => pick(Number(v))));
    } else if (spec.kind === 'chordtype') {
      el.pdFields.append(pdSelect(t(spec.label), `pd-${spec.field}`,
        CHORD_TYPES.map((n, i) => [i, n]), current ?? 0, (v) => pick(Number(v))));
    } else if (spec.kind === 'retrigger') {
      el.pdFields.append(pdSelect(t(spec.label), `pd-${spec.field}`,
        RETRIGGER_RULES.map((n, i) => [i, n]), current ?? 0, (v) => pick(Number(v))));
    } else {
      el.pdFields.append(pdNumber(t(spec.label), `pd-${spec.field}`, current ?? 0, 0, 127, pick));
    }
  }

  const staged = state.casmOps.filter((o) => o.op === 'field').length;
  el.pdSummary.textContent = staged ? t('pdet_staged', { n: staged }) : '';
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

  if (operation.op === 'channel' || operation.op === 'field') {
    // One operation per cell (or per field), holding the state the user asked
    // for. Appending instead would make a second click on the same dot a second
    // operation rather than a reversal, and - worse - switching off a part that
    // was already on by default would store "off" as if it were an edit, when
    // the file already says off and there is nothing to write.
    const at = state.casmOps.findIndex(
      (o) => o.op === operation.op && o.section === operation.section && o.channel === operation.channel
        && (o.op === 'channel' || o.field === operation.field),
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
    if (op.op !== 'channel' && op.op !== 'field') return true;
    const section = original.sections.find((s) => s.name === op.section);
    // A cell whose section has been renamed or deleted cannot be compared, so it
    // is kept and left for the writer to resolve.
    if (!section) return true;
    if (op.op === 'channel') return section.channels.includes(op.channel) !== op.on;
    const part = section.parts.find((p) => p.channel === op.channel);
    if (!part) return true;
    return pdDiffers(part, op.field, op.value);
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
    `${s.version}${s.container === 'bare-smf' ? ` (${t('filemeta_nocontainer')})` : ''} \u00b7 ${formatBytes(s.buffer.byteLength)} \u00b7 ` +
    `${s.payloads.map((p) => p.kind).join(' + ')} \u00b7 ${cnt(s.notes.length, 'note')} \u00b7 ${bpm.toFixed(1)} BPM \u00b7 ` +
    `${s.meter.numerator}/${s.meter.denominator} \u00b7 ${cnt(s.meter.bars, 'bar')} \u00b7 ${t('clock_s', { s: secs.toFixed(1) })} \u00b7 ${used}`;
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
    d.title = t('vv_tl_title', { name: v.name, bars: cnt(v.bars, 'bar'), notes: cnt(v.notes, 'note') });
    blockWrap.append(d);
  }
  if (marked.length === 0) {
    const d = document.createElement('div');
    d.className = 'tl-block';
    d.style.flex = '1';
    d.textContent = state.notes.length ? t('tl_no_markers') : t('editor_hint_nonotes');
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
    name.title = t('voice_channel', { ch: r.channel + 1 });
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
        c.title = t('tl_cell', { b: bar + 1, n: cnt(n, 'note') });
      }
      lanes.append(c);
    }
    row.append(name, lanes);
    el.timeline.append(row);
  }

  const inferred = false;
  const notes = [
    s.variations?.length
      ? t('tl_from_markers', { n: cnt(s.variations.length, 'variation') })
      : t('tl_inferred'),
    s.meter.source === BLOCK_SOURCE.inferred && s.meter.decl ? t('tl_grid44', { note: t('tl_meter_sub', { decl: s.meter.decl }) }) : '',
  ].filter(Boolean).join(' ');
  el.timelineHint.textContent = notes || cnt(bars, 'bar');
}

function renderVoices() {
  el.voices.textContent = '';
  if (state.rows.length === 0) {
    el.voices.innerHTML = `<p class="empty">${t('nl_no_parts')}</p>`;
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
      `<div class="voice-ch">${t('voice_ch', { ch: r.channel + 1 })}</div>` +
      `<div class="voice-pitch">${noteName(r.low)}–${noteName(r.high)}<div class="bar-mini"><i></i></div></div>` +
      `<div class="voice-vel">${t('voice_vel_avg', { lo: r.velMin, hi: r.velMax, avg: avg.toFixed(0) })}</div>`;
    el.voices.append(row);
    // The mini bar width is a value, not markup: set it through the CSSOM so
    // the HTML carries no style="" attribute.
    const mini = row.querySelector('.bar-mini i');
    if (mini) mini.style.width = `${Math.min(100, (r.count / busiest) * 100).toFixed(0)}%`;
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
    tag.innerHTML = `<b>${esc(t(secKey(sectionLabel(name))))}</b> ${esc(name)}`;
    el.declared.append(tag);
  }
  const notice = document.createElement('p');
  notice.className = 'notice';
  notice.textContent = t('declared_notice');
  el.declared.append(notice);
  el.declaredHint.textContent = t('declared_by', { n: cnt(s.structure.declaredSections.length, 'section') });
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
    ? t('ec_none')
    : [
      mapChanges ? t('ec_map', { n: mapChanges }) : null,
      state.added.length ? t('ec_added', { n: state.added.length }) : null,
      state.removed.size ? t('ec_removed', { n: state.removed.size }) : null,
      state.pendingVelocity.size ? t('ec_velocity', { n: state.pendingVelocity.size }) : null,
      state.pendingShape.size ? t('ec_pitch', { n: state.pendingShape.size }) : null,
    ].filter(Boolean).join(' \u00b7 ');

  // The selection, not the part on screen: the bulk controls and the download
  // both work across every included part.
  const chosen = bulkTargetNotes();
  const bulkWrites = state.bulkVelocity !== null
    && chosen.some((n) => (pendingVelocityOf(n) ?? n.velocity) !== clampVelocity(v));
  el.btnDownload.disabled = chosen.length === 0 && total === 0 && !bulkWrites && mapChanges === 0;
  el.saveHint.textContent = mapChanges
    ? t('save_map_write', { n: cnt(mapChanges, 'change') })
    : t('save_hint_default');

  if (chosen.length === 0) {
    el.summary.innerHTML = `<b>${t('summary_no_match')}</b> - ${t('summary_no_match_hint')}`;
    return;
  }
  const distinct = [...new Set(chosen.map((n) => n.note))].sort((a, b) => a - b);
  const now = chosen.map((n) => pendingVelocityOf(n) ?? n.velocity);
  const orig = chosen.map((n) => n.velocity);
  const changed = now.filter((x, i) => x !== orig[i]).length;
  const parts = [...new Set(chosen.map((n) => n.channel))].length;
  const preview = distinct.slice(0, 12).map((n) => noteName(n)).join(', ');
  const more = distinct.length > 12 ? t('sum_more', { n: distinct.length - 12 }) : '';
  el.summary.innerHTML =
    t('sum_line1', { n: `<b>${chosen.length}</b>`, parts: `<b>${cnt(parts, 'part')}</b>`, pitches: cnt(distinct.length, 'pitch'), preview, more }) +
    t('sum_line2', { lo: Math.min(...now), hi: Math.max(...now), avg: (now.reduce((a, b) => a + b, 0) / now.length).toFixed(1), wlo: Math.min(...orig), whi: Math.max(...orig), changed: changed }) +
    '';
}

// ---- operations -------------------------------------------------------------

function runOperation(kind) {
  if (!state) return;
  const notes = editableNotes();
  if (!notes.length) {
    say(t('no_notes_range'), 'warn');
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
  say(t('op_applied', { kind: t(OP_LABEL_KEY[kind] ?? kind), n: cnt(notes.length, 'note'), part: state.rows.find((r) => r.channel === state.activeChannel)?.label ?? t('this_part') }), 'ok');
}

/** Bulk-operation kind to its dictionary label key (see ops_* in i18n.js). */
const OP_LABEL_KEY = {
  set: 'ops_set',
  scale: 'ops_scale',
  offset: 'ops_offset',
  humanize: 'ops_humanize',
  random: 'ops_random',
  curve: 'ops_curve',
  accent: 'ops_accent',
};

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
        say(t('clash_warn', { n: cnt(clashes.length, 'pair') }), 'warn');
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
      say(t('map_leftout', { err: err.message }), 'warn');
    }
    if (!casm) {
      say(t('no_map_write'), 'warn');
    } else {
      const applied = applyCasmOperations(casm, state.casmOps);
      if (!applied.ok) {
        say(t('stopped_reason', { reason: applied.reason }), 'warn');
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
    say(t('storage_denied'), 'warn');
  }
}

function renderPresets() {
  const list = readPresets();
  el.presetList.textContent = '';
  if (!list.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = t('preset_empty');
    el.presetList.append(empty);
    return;
  }
  for (const preset of list) {
    const chip = document.createElement('span');
    chip.className = 'preset-item';
    const apply = document.createElement('button');
    apply.className = 'btn btn-sm';
    apply.textContent = preset.name;
    apply.title = t('preset_title', { v: preset.velocity?.size ?? 0, s: preset.shape?.length ?? 0 });
    apply.addEventListener('click', () => applyPreset(preset));
    const drop = document.createElement('button');
    drop.className = 'btn btn-sm btn-ghost';
    drop.textContent = '\u00d7';
    drop.title = t('mv_delete');
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
  say(t('preset_applied', { name: preset.name }), 'ok');
}

function savePreset() {
  if (!state) return;
  const name = el.presetName.value.trim() || t('preset_default_name', { n: readPresets().length + 1 });
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
  say(t('preset_saved', { name }), 'ok');
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

/**
 * @param {boolean} usePreview
 * @param {number} fromTick
 * @param {{startTick: number, endTick: number, loop: boolean, countIn: number}} [region]
 */
async function play(usePreview, fromTick = 0, region = null) {
  if (!state) return;
  const ctx = await ensureAudio();
  if (!player) {
    player = new Player(ctx);
    // The engine only exists from the first playback onwards, so the settings the
    // player chose before that have to reach it now.
    applyPlaySettings();
  }

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
  // The whole-file transport plays everything and never counts in; playVariation
  // passes a region and gets the opposite.
  player.setRegion(region ? { startTick: region.startTick, endTick: region.endTick } : null,
    region?.loop ?? false);
  player.setCountIn(region?.countIn ?? 0, state.tpb);
  player.onEnded = () => {
    el.btnPlay.textContent = PLAY_LABEL();
    el.btnPlayVariation.textContent = t('btn_play_var');
    cancelAnimationFrame(rafId);
    roll?.setPlayhead(null);
    lane?.setPlayhead(null);
    draw();
  };
  player.start(fromTick);
  el.btnPlay.textContent = PAUSE_LABEL();
  if (region) el.btnPlayVariation.textContent = t('btn_stop_var');
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
  el.btnPlay.textContent = PLAY_LABEL();
  el.btnPlayVariation.textContent = t('btn_play_var');
  cancelAnimationFrame(rafId);
  const ph = document.querySelector('.tl-playhead');
  ph?.remove();
  roll?.setPlayhead(null);
  lane?.setPlayhead(null);
  if (state) draw();
  el.clock.textContent = t('clock_s', { s: '0.0' });
}

function tickPlayhead() {
  if (!player?.playing || !state) return;
  const secs = player.position();
  el.clock.textContent = t('clock_s', { s: secs.toFixed(1) });

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

// Interface language: Arabic by default, English one click away in the
// header. Static chrome swaps first, then the whole view re-renders so every
// dynamic string follows. The choice persists in this browser.
initLang();
applyI18n(document);
el.btnLang?.addEventListener('click', () => {
  setLang(getLang() === 'ar' ? 'en' : 'ar');
  // Static chrome already swapped inside setLang; re-render the dynamic
  // regions so they follow. Nothing is loaded yet before the first file.
  if (!state) return;
  refresh();
  renderMap();
  renderVariations();
  renderLift();
  renderMeta();
  renderTimeline();
  renderVoices();
  renderDeclared();
  renderPresets();
});

el.voices.addEventListener('click', (e) => {
  const row = e.target.closest('.voice');
  if (!row || !state) return;
  const ch = Number(row.dataset.channel);
  if (state.selected.has(ch)) state.selected.delete(ch);
  else state.selected.add(ch);
  renderVoices();
  refresh();
  // The chosen parts are what a variation will sound, so the note beside the play
  // button has to follow them.
  describePlayVariation();
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
  say(t('edits_discarded'), 'ok');
});

el.btnCopyMap.addEventListener('click', async () => {
  if (!state || !mapView) return;
  const text = mapView.toText();
  try {
    await navigator.clipboard.writeText(text);
    say(t('map_copied'), 'ok');
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

/**
 * Play one variation on its own, optionally repeating it.
 *
 * The region comes from the file's markers, so this plays the bars the style itself
 * calls that variation. It shares the transport's sound and the same "preview edit"
 * switch, because auditioning a change is the reason to play one variation rather
 * than the whole file.
 */
async function playVariation() {
  const variations = state?.variations ?? [];
  const v = variations[Number(el.playVariation.value)];
  if (!v) {
    say(t('no_markers_play'), 'warn');
    return;
  }
  // Always starts at the variation. The "preview edit" switch decides which values
  // the notes are played with, not where the variation begins - starting at zero
  // because an edit was staged would play the whole style instead.
  await play(true, v.startTick, {
    startTick: v.startTick,
    endTick: v.endTick,
    loop: el.playLoop.checked,
    countIn: Number(el.playCountIn.value),
  });
  el.btnPlay.textContent = t('btn_playing_var');
  say((el.playLoop.checked ? t('playing_var_rep', { v: v.name }) : t('playing_var', { v: v.name }))
    + (Number(el.playCountIn.value) ? ` ${t('playing_var_countin', { n: cnt(Number(el.playCountIn.value), 'bar') })}` : '')
    + `. ${t('playing_var_stop')}`, 'ok');
}

// Every control in that row has to reach the engine, not just the variation: the
  // count-in and the repeat are chosen there too, and a Play that ignored them
  // would be a button that quietly does something else.
for (const control of [el.playVariation, el.playCountIn, el.playLoop]) {
  control.addEventListener('change', describePlayVariation);
}
el.btnPlayVariation.addEventListener('click', playVariation);

el.btnPlay.addEventListener('click', () => {
  if (player?.playing) {
    stopPlayback();
    return;
  }
  play(true).catch((err) => say(t('playback_failed', { err: err?.message ?? err }), 'warn'));
});
el.btnStop.addEventListener('click', stopPlayback);
el.btnPlayOriginal.addEventListener('click', () =>
  play(false).catch((err) => say(t('playback_failed', { err: err?.message ?? err }), 'warn')),
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
      ? t('wrote_into', { parts: parts.join(' and '), file: editedName() })
      : t('no_changes_copy', { file: editedName() }), 'ok');
  } catch (err) {
    say(t('write_failed', { err: err?.message ?? err }), 'warn');
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
  say(t('exported_n', { n: cnt(payload.notes.length, 'note') }), 'ok');
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
    say(t('imported_of', { hits, total: (data.notes ?? []).length }), hits ? 'ok' : 'warn');
  } catch (err) {
    say(t('json_unreadable', { err: err?.message ?? err }), 'warn');
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
  /**
 * What playing a variation would schedule, for the browser tests.
 *
 * The engine's own queue, not a recount from the note list: the whole question is
 * whether the region filter and the count-in put the right things in front of the
 * clock, and asking the engine is the only version of that answer that cannot
 * disagree with what would sound.
 */
  scheduled: () => {
    if (!player || !state) return { notes: [], clicks: [], region: null, countIn: 0, musicFrom: 0 };
    const v = (state.variations ?? [])[Number(el.playVariation.value)] ?? null;
    const region = v ? { startTick: v.startTick, endTick: v.endTick } : null;
    const queue = region
      ? player.queue.filter((q) => q.atTick >= region.startTick && q.atTick < region.endTick)
      : player.queue;
    return {
      notes: queue.map((q) => ({ tick: q.atTick, pitch: q.note, velocity: q.velocity })),
      clicks: player.countInClicksFor(region ? region.startTick : 0),
      countIn: player.countIn,
      musicFrom: player.toSeconds ? player.toSeconds(region ? region.startTick : 0) : 0,
      region,
    };
  },
  /** How many times the repeated variation has come round. */
  loops: () => player?.loops ?? 0,
  /** The engine's own view of what it is doing, for diagnosing a stuck repeat. */
  playerState: () => (player ? {
    playing: player.playing,
    loop: player.loop,
    loops: player.loops,
    voices: player.voices,
    cursor: player.cursor,
    queueLength: player.queue.length,
    activeLength: player.activeQueue?.length ?? null,
    regionFrom: player.regionFrom ?? null,
    regionTo: player.regionTo ?? null,
  } : null),
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