# Yamaha Style Velocity Editor

Inspect, audition and edit drum-note **velocity** inside Yamaha `.STY` style
files — in the browser, with no server and no upload.

Built for PSR-A5000, Genos and other arrangers that read SFF2 styles, but the
reader also accepts SFF1 and the bare-MIDI `.STY` exports that style utilities
produce.

---

## What it does

1. You drop a `.STY` file onto the page.
2. It reads the container, indexes every note-on with its channel, pitch,
   velocity and position in time, and reads the style's declared part names and
   sections out of the `CASM` chunk.
3. You get four views:
   - **Timeline** — one lane per part across the bar grid, with blocks marked
     where the sounding parts change.
   - **Parts** — one row per channel with pitch range, note count and velocity
     spread. Click a row to include or exclude it.
   - **Velocity** — set a value from 1 to 127 for the selected parts and pitch
     range, with a live count of what will change.
   - **Declared sections** — the section names the style advertises.
4. You press **Play** and hear the result. Velocity maps to amplitude, so a
   value of 40 is audible as a ghost note and 127 as a full hit.
5. You download the edited style. The original file is never modified.

## Running it

Open `index.html` in a browser. There is no build step and no dependency to
install for normal use.

If your browser blocks ES modules from `file://`, serve the folder instead:

```sh
npm run serve      # http://localhost:5173
```

## Privacy

The file is read with `FileReader`/`ArrayBuffer` and never leaves the tab. The
page makes no network requests after loading. That is verifiable: open the
browser's network panel and watch it stay empty while you edit.

## About the playback sound

Playback is a synthesiser, not a sound bank. The styles reference Genos and PSR
voices (`D:/MULTI PAD/GuitarPhrase/...`) that are not redistributable, so the
instrument's actual timbres cannot be reproduced here.

What playback *is* faithful about is dynamics — velocity drives amplitude
exactly, on a squared curve — so an edit is judgeable by ear. What it is not is
timbre: a `NylonGtr` part will not sound like a nylon guitar.

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

### Sections are declared, not recoverable

`CASM` lists the section names the original style advertises — `Main A`,
`Fill In AA`, `Intro B`, `Ending C` and so on. It does **not** record where those
sections start in time, because these exports flatten the performance into one
timeline. So the notes are grouped by part, and the timeline's "blocks" are
inferred from where the sounding parts change. Both are labelled as such in the
interface.

`Bridge` appears in the declared list only if the style declares one; most of
this collection does not.

### Nothing is patched silently

The patcher writes single bytes into a copy of the input. The container header,
chunk lengths and all metadata are carried over verbatim, because the player
validates the container and rejects a style whose declared lengths disagree with
its contents. Tests assert the output is byte-for-byte the same length as the
input and that only the intended bytes differ.

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

## Tests

```sh
npm test                       # 48 parser, structure and audio tests
npx playwright install chromium  # once, for the browser checks
npm run serve                  # in one terminal
npm run test:browser           # 48 browser checks across two files
```

The parser tests run against synthetic fixtures built in the test files rather
than real styles. That is deliberate: they assert exact byte offsets, so a
regression shows up as a wrong offset rather than a subtly wrong file that only
fails on hardware. Real Yamaha files are not committed to this repository.

`test/audio.test.js` drives the player against a stubbed `AudioContext`, which is
the only way to assert the scheduling maths — velocity-to-gain curve, voice cap,
envelopes — without a sound card.

`test/inspect.e2e.mjs` and `test/ui.e2e.mjs` drive the real page: they upload a
file, play it, move the playhead, download the result and re-parse it. Counting
audio nodes from the page proved unreliable (a subclassed `AudioContext` is not
always the one the engine ends up calling), so the browser tests assert
observable behaviour — clock, playhead, transport state — and leave the audio
parameters to the unit tests.

## Limitations — please read

- **No SFF2 `Sdst` section matrix.** Real arranger styles keep their section
  layout in `Sdst`, which would give exact per-section note attribution. None
  was available during development, so it is not implemented rather than
  implemented and guessed.
- **Timbre is an approximation**, as described above.
- **Velocity only.** Timbre, note length and the pattern section are out of
  scope.
- **Editing flattens dynamics by design.** Setting every selected note to one
  value removes the original accent pattern within that selection. Narrow the
  pitch or part range if you only want one drum part.
- **Metadata is not rewritten.** Name, category and part names stay as they
  were. Rename a style in the arranger's own editor.
- **No undo in the page.** Re-download the original to compare.

## License

MIT

