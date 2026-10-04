# Yamaha Style Editor

Edit **velocity, pitch and note length** inside Yamaha `.STY` style files — in the
browser, with a piano roll, and with no server and no upload.

Built for PSR-A5000, Genos and other arrangers that read SFF2 styles, but the
reader also accepts SFF1 and the bare-MIDI `.STY` exports that style utilities
produce.

---

## What it does

1. You drop a `.STY` file onto the page.
2. It reads the container, indexes every note-on with its channel, pitch,
   velocity and position in time, and reads the style's declared part names and
   sections out of the `CASM` chunk.
3. You pick a part and edit it in two linked views:
   - **Piano roll** — one canvas per part. Drag a note up or down to retune it,
     drag its right edge to change its length, drag empty space to pan, wheel to
     zoom, shift+wheel for height, double-click to seek.
   - **Velocity lane** — one draggable bar per note, sharing the roll's time scale
     so a note and its bar always sit at the same x.
4. Or you work in bulk, on the part you have selected: set, scale, offset,
   humanise, randomise, curve by position, or accent what is already loud.
5. You press **Play** and hear the result with the pending edit applied, or the
   file's own values. Velocity maps to amplitude, so 40 is audible as a ghost note
   and 127 as a full hit.
6. You download the edited style, save the edit as a browser preset, or export it
   as JSON. The original file is never modified.

Edits are **staged, not applied**. The file in memory stays exactly as it was
loaded until you download; **Revert** throws the whole edit away.

## The gestures

| Gesture | Effect |
| --- | --- |
| Drag a bar in the lane | Set that note's velocity |
| Drag a note up or down | Retune it, on the note-on *and* the note-off |
| Drag a note's right edge | Change its length |
| Click a part row | Include or exclude it from playback and bulk operations |
| Double-click a part row | Bring it up in the roll |
| Ctrl + wheel | — |

## Running it

Open `index.html` in a browser. There is no build step and no dependency to
install for normal use.

If your browser blocks ES modules from `file://`, serve the folder instead:

```sh
npm run serve      # http://localhost:5173
```

## Privacy

The file is read with `FileReader`/`ArrayBuffer` and never leaves the tab. The
page makes no network requests after loading. Presets go to `localStorage`, which
is also local. That is verifiable: open the browser's network panel and watch it
stay empty while you edit.

## About the playback sound

Playback is a synthesiser, not a sound bank. The styles reference Genos and PSR
voices (`D:/MULTI PAD/GuitarPhrase/...`) that are not redistributable, so the
instrument's actual timbres cannot be reproduced here.

What playback *is* faithful about is dynamics — velocity drives amplitude exactly,
on a squared curve — so an edit is judgeable by ear. What it is not is timbre: a
`NylonGtr` part will not sound like a nylon guitar.

Drum parts get pitch-aware percussion: kick, snare, hats and cymbals are
distinguished by MIDI note number, so a drum pattern is recognisable and its
accents are audible. Pitched parts get a short synth voice chosen per part
family.

## How it works

### Two shapes of file

A `.STY` may be either an SFF container or a plain Standard MIDI File:

```
SFF2 header
  Smed  <- MIDI data
    MID  <- the performance as authored
    MER  <- the performance as played back
```

or

```
MThd
  MTrk  <- one flat performance, every part on its own channel
  CASM  <- declared section names and part names
  OTSc  <- per-voice parameter tables
```

Both are read. The bare-MIDI shape is not hypothetical: a collection of 191
exported `.T473.STY` files, every one of them of this form.

### Both copies are patched

A container style carries the same performance twice. Newer arrangers read
`MER`, older ones read `MID`. Editing only one means the change is silent on half
the hardware in the family, so every payload found is patched. Not every writer
puts a standard `MThd` in the second copy — a `MER` payload can be bare `MTrk`
chunks behind proprietary header bytes — so `indexTracksOnly` handles that too.

If a payload still cannot be read, the page names it and warns that the edit will
only reach the readable copy, rather than silently doing half a job.

### Velocity and length are written in completely different ways

This is the central fact of the whole editor.

**Velocity** is one byte, and **pitch** is one byte written twice — once on the
note-on and once on its note-off, or the pair stops matching and the note reads as
hanging. Neither moves anything, so both are single-byte writes into a copy of the
file. Every other byte, including the container header and all chunk lengths, is
carried over verbatim.

**Length** is not fixed-width. A note's length is the delta-time before its
note-off, and delta-times are variable-length, so lengthening a note can turn a
one-byte delta into two and shift every byte after it. Worse, MIDI events are
ordered by tick and a note-off may legally sit *after* a later note-on — but only
if the list is re-sorted. So a length edit re-emits the whole track, re-sorting
stably by tick, and then fixes every enclosing length: the `MTrk`, then `MID` or
`MER`, then `Smed`.

That is why the two are staged separately and written in a fixed order: the
structural edits go in first, the file is re-read to get fresh offsets, and only
then are the velocity bytes written. Writing velocity first would leave it writing
to offsets that no longer exist.

### The round trip is the contract

Everything above rests on one testable claim: parse a track, write it straight
back with nothing changed, and get the identical bytes. `test/track.test.js`
asserts that for plain notes, meta events, sysex, running status, control and
program changes, and every delta-time boundary from 0 to 16384 — and, most
importantly, for the **real exported style**, where all 39404 bytes of the track
come back unchanged.

If that test ever fails, no length edit should be trusted. It is the thing that
makes the rest safe rather than hopeful.

### Sections are declared, not recoverable

`CASM` lists the section names the original style advertises — `Main A`,
`Fill In AA`, `Intro B`, `Ending C` and so on. It does **not** record where those
sections start in time, because these exports flatten the performance into one
timeline. So the notes are grouped by part, and the timeline's "blocks" are
inferred from where the sounding parts change. Both are labelled as such in the
interface.

`Bridge` appears in the declared list only if the style declares one; most of
this collection does not.

### Two things that can bite, and are checked for

- **Overlapping notes on one key.** The parser pairs a release with the oldest
  open note of the same channel and pitch. Two overlapping notes on one key
  therefore do not each keep their own length — they silently swap. Transposing a
  note onto a neighbour's pitch is the easy way to cause it, and the result still
  parses, so it would otherwise pass unnoticed. The editor warns before saving.
- **A part that stays silent for most of the file.** The drums in the reference
  style do not sound until well past the halfway point, so the roll opens on the
  part's *first note* rather than on bar 1.

### Time handling

Three things in the time domain are easy to get wrong, and each had a test
written after it was got wrong:

- **Tempo is microseconds per quarter, not per tick.** Dividing ticks straight by
  that value reports a two-minute performance as fifty-seven hours. The file's
  `division` has to be applied first.
- **A time signature's numerator counts beats and its denominator names the note
  value for one beat**, so a bar holds `numerator * 4 / denominator` quarters:
  6/8 is three quarters, 10/16 is two and a half. Dividing by the denominator
  instead puts 6/8 at twelve quarters per bar.
- **Meta event bodies start after the variable-length length field.** Reading from
  the length bytes themselves yields a plausible-looking but wrong tempo and
  meter.

A declared meter that would imply an absurd bar count is replaced by 4/4 and the
substitution is reported, and the grid is capped so a bad decode cannot ask the
DOM for hundreds of thousands of nodes.

### Why the views are canvas

A single exported style holds four thousand-odd notes. As DOM nodes that is
thousands of elements to lay out on every pan frame, and dragging a velocity bar
would stutter. Canvas draws the visible window only, so cost scales with what is
on screen.

The views hold pending edits as *overrides* keyed by file offset rather than
writing into the note objects. That is not a detail: if a drag mutated the note,
the editor could no longer tell what the file said from what the user had done,
and would discard every edit as a no-op.

## Tests

```sh
npm test                          # 118 unit tests
npx playwright install chromium   # once, for the browser checks
npm run serve                     # in one terminal
npm run test:browser              # 123 browser checks across four files
```

The parser tests run against synthetic fixtures built in the test files rather
than real styles. That is deliberate: they assert exact byte offsets, so a
regression shows up as a wrong offset rather than a subtly wrong file that only
fails on hardware. Real Yamaha files are not committed to this repository.

`test/audio.test.js` drives the player against a stubbed `AudioContext`, which is
the only way to assert the scheduling maths — velocity-to-gain curve, voice cap,
envelopes — without a sound card.

The browser checks drive the real page with a real pointer, then read the
downloaded file back and ask the parser what actually changed:

- `test/ui.e2e.mjs` — an SFF2 container with both payloads, and one payload that
  cannot be read and must be reported rather than swallowed.
- `test/inspect.e2e.mjs` — the inspector, the timeline, and playback. Counting
  audio nodes from the page proved unreliable (a subclassed `AudioContext` is not
  always the one the engine ends up calling), so these assert observable
  behaviour — clock, playhead, transport state.
- `test/editor.e2e.mjs` — the roll and the lane: a real drag has to reach the
  file, a length edit has to resize the right track without losing the other, and
  presets and the JSON sidecar have to survive a round trip.
- `test/real.e2e.mjs` — the reference export, end to end: 4592 notes, twelve
  channels. Asserts that a one-note edit changes exactly one byte, and that the
  saved file still re-emits byte-for-byte. Skips itself if the file is not
  present.

## Limitations — please read

- **No SFF2 `Sdst` section matrix.** Real arranger styles keep their section
  layout in `Sdst`, which would give exact per-section note attribution. None
  was available during development, so it is not implemented rather than
  implemented and guessed.
- **Timbre is an approximation**, as described above.
- **Retuning and resizing are supported but riskier than velocity.** Velocity is a
  single byte and cannot go wrong structurally. Pitch has to be written twice and
  can create an overlap; length re-serialises the track. Both are covered by tests
  against the real file, but check the result in an arranger before relying on it
  on hardware.
- **Bulk transforms flatten dynamics by design.** Setting every note in a
  selection to one value removes the original accent pattern within it. Narrow the
  part or pitch range if you only want one drum part. Humanise uses a seeded
  generator, so re-running it is reproducible.
- **Metadata is not rewritten.** Name, category and part names stay as they
  were. Rename a style in the arranger's own editor.
- **No undo in the page.** There is Revert, which discards *all* pending edits,
  and presets, but not a per-gesture undo stack. Re-download the original to
  compare.

## License

MIT
