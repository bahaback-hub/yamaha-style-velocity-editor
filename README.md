# Yamaha Style Editor

Read a Yamaha `.STY` file, **see the map of every variation it contains**, edit
that map, and edit the velocity, pitch and length of its notes. All in the
browser, with no server and no upload.

Built for PSR-A5000, Genos and other arrangers, and tested against a collection of
real exported Arabic styles.

---

## The variation map

This is the main screen, and it is the thing the file actually knows.

Every style declares, for each of its variations, which parts sound:

```
CASM
  CSEG  <- Main A          Sdec "Main A" + one record per part
  CSEG  <- Main B
  CSEG  <- Intro A
  CSEG  <- Ending A
  ...
```

The table shows one row per variation and one column per part, a dot where the part
sounds. **Click a dot to switch that part on or off for that variation alone.**
Copy duplicates a variation so you can build a new one from a starting point;
Rename and Delete work on the whole group.

Two things the table tells you honestly rather than hiding:

- **How complete the map is.** Most exported styles carry fewer than the full
  fifteen variations — the ones the arranger's editor happened to write. The page
  says so instead of quietly showing seven rows.
- **When a column is ambiguous.** A channel can carry different part names in
  different variations (`Clavi` in most of a style, `Pad` in its ending). Those
  columns are marked, because "which part is this" stops having one answer.

### What plays when

The variation map says **which parts play in each variation**. The **markers** in the
file say **when each one starts** — Yamaha styles carry an `FF 06` marker event at the
top of every variation, so the boundaries are read, not guessed:

- **What plays when** lays the form out as one bar per variation, sized by where the
  file says it starts and ends, in the order the style actually plays them.
- Each row is ticked when the parts that sounded during it match what the map
  declares, and says so when one does not. A setup section like `SInt` appears
  without being declared in the map, which is a real difference rather than an error.
- **Lift one note** then changes the velocity of every occurrence of a single note,
  either across the whole style or in the one variation you select. The count of
  occurrences it will touch is written out before you press the button.
- **Play one variation** plays just that variation, on its own, with **Repeat** to
  start it again when it ends and a **count-in** of one or two bars before it. It
  opens on Main A, and says so when a variation holds none of the parts you have
  switched on, rather than playing silence without explanation.

This was wrong earlier. The tool used to claim that note-to-variation attribution was
impossible because styles "flatten the performance into one timeline" — but the
timeline is flattened, and the markers still sit on it saying where each variation
begins. Both are now used.

---

## Editing notes

Below the map, one part at a time:

- **Piano roll** — drag a note up or down to retune it, drag its right edge to
  change its length, drag empty space to pan, wheel to zoom, shift+wheel for
  height, double-click to seek.
  - **Double-click an empty spot** to put a note there. It arrives with a velocity
    of 100 and a sixteenth of a bar, and is retuned and resized like any other.
  - **Alt-click a note** to take it out. It stays on screen, faded and dashed, so
    you can see what is leaving and alt-click it again to keep it.
- **Velocity lane** — one draggable bar per note, sharing the roll's time scale so
  a note and its bar always sit at the same x.
- **Bulk transforms** on the part you have selected: set, scale, offset, humanise,
  randomise, curve by position, or accent what is already loud.

Edits are **staged, not applied**. The file in memory stays exactly as it was
loaded until you download; **Revert** throws the whole edit away.

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

### Two places the form is recorded, and both are authoritative

`CASM` lists the section names the original style advertises — `Main A`, `Main B`,
`Intro A`, `Ending A` and so on — and, per variation, which parts sound. That is what
the variation map shows.

The boundaries in **time** come from the marker events (`FF 06`) in the performance
track, one per variation, at the tick where it begins. `CASM` does not carry them, and
the two are independent: a section can be declared without a marker, and a marker can
name something the map never declares (`SInt`, the setup section, is the usual one).
**What plays when** puts the two side by side and marks any that disagree rather than
quietly picking one.

Anything before the first marker or after the last one is reported as a prologue or
epilogue rather than being folded into a neighbour, because both are real regions of
the file.

`Bridge` appears in the declared list only if the style declares one; most of
this collection does not.

### Reading `CASM` rather than recognising it

The `CSEG` structure is read from the documented layout rather than by spotting byte
patterns, and the read is checked against every style in the test collection:

- each `CSEG` holds an `Sdec` header followed by one 55-byte `Ctb2` record per part;
- all **202** styles in the collection re-serialise byte-identically, covering **6977**
  part records, every one 47 bytes of body;
- all **202** carry markers, and the **1563** variation spans they produce match their
  declared maps.

The byte pattern approach was not reliable — a parser built on it happened to agree
with real files on the first few and disagreed further in, which is the worst way to
be wrong.

### The map's record layout, and why it is safe to write

Each part inside a variation is a **55-byte** record: a 7-byte `Ctb2` tag, the
`0x2F` marker, the channel number, an 8-byte padded part name, and 38 parameter
bytes that begin with the channel number again. The arithmetic checks out on real
files — a `Main A` with six parts is `14 + 6 * 55 = 344` bytes, a `Main B` with
five is `14 + 5 * 55 = 289`, and `Intro A` at 125 is a seven-character name plus
two records.

Those 38 parameter bytes are not decoded. They describe the voice rather than the
map, and they are carried through verbatim in both directions, so an edit to the
map cannot disturb them.

The gate on all of this is one test: **parse every style in the collection, write
it straight back with nothing changed, require identical bytes.** That holds for
all 202 of them. If it ever stops holding, no map edit should be trusted.

Switching a part **on** copies its 38 parameter bytes from a variation that
already uses that channel, because a record without them lists a part the arranger
cannot play. That is why the tool refuses to switch on a channel no other
variation uses, rather than inventing zeros.

### One thing that was wrong and is now fixed

The CASM channel byte is the **same zero-based number the MIDI events use**. It
used to be read as one-based and have one subtracted, which put every part name one
channel to the left of the notes it belonged to — a drum part inherited the bass's
name and the timeline showed the wrong instrument on the wrong lane.

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
npm test                          # 135 unit tests
npx playwright install chromium   # once, for the browser checks
npm run serve                     # in one terminal
npm run test:browser              # 138 browser checks across four files
```

The parser tests run against synthetic fixtures built in the test files rather
than real styles. That is deliberate: they assert exact byte offsets, so a
regression shows up as a wrong offset rather than a subtly wrong file that only
fails on hardware. Real Yamaha files are not committed to this repository.

`test/cseg.test.js` is the exception, and it is the important one: it walks the
user's own `Saudi 1` collection on this machine and requires every one of those
styles to rebuild to identical bytes. When the folder is absent the suite says so
and the synthetic cases carry the weight alone.

`test/audio.test.js` drives the player against a stubbed `AudioContext`, which is
the only way to assert the scheduling maths — velocity-to-gain curve, voice cap,
envelopes — without a sound card. The stub's clock is writable, so time can be moved
by hand and the region, repeat and count-in behaviour checked exactly rather than by
waiting on a real one.

The browser checks drive the real page with a real pointer, then read the
downloaded file back and ask the parser what actually changed:

- `test/ui.e2e.mjs` — an SFF2 container with both payloads, and one payload that
  cannot be read and must be reported rather than swallowed.
- `test/inspect.e2e.mjs` — the inspector, the timeline, and playback. Counting
  audio nodes from the page proved unreliable (a subclassed `AudioContext` is not
  always the one the engine ends up calling), so these assert observable
  behaviour — clock, playhead, transport state.
- `test/editor.e2e.mjs` — the roll, the lane and the variation map: a real drag
  has to reach the file, a length edit has to resize the right track without
  losing the other, and a map toggle has to grow the file by exactly one 55-byte
  record while leaving every note byte alone. Toggling a dot back must restore the
  original file byte for byte. Also covers adding a note by double-clicking, taking
  one out with alt-click, putting it back, and clearing both with revert. Reads the
  two marked variations back out of the form, in the order the file plays them.
- `test/lift.e2e.mjs` — lifting one note's velocity: a fixture built so the same
  note repeats through two marked variations at two different volumes, so "every
  occurrence" and "this variation only" have different, checkable answers. Asserts
  the downloaded file, not just what the page claims.
- `test/real.e2e.mjs` — the reference export, end to end: 4592 notes, twelve
  channels. Asserts that a one-note edit changes exactly one byte, and that the
  saved result still re-emits byte-for-byte. Skips itself if the file is not
  present.

`npm run test:browser` runs every one of them, all the way through, even after one
fails. It used to chain with `&&`, which meant the first failure stopped the run and
hid whatever was broken after it — that is how a set of bulk operations sat silently
disabled while a shorter suite still reported a pass.

## Limitations — please read

- **The boundaries are the file's own.** Variation boundaries come from the marker
  events, so they are exact rather than inferred, and the map is authoritative
  separately. Where the two disagree, **What plays when** says which and does not
  pick a winner.
- **Untested on hardware.** Nothing here has been loaded into a PSR-A5000. The
  byte-level work is proven against the file format, but whether the instrument
  honours an edited `CASM` has to be confirmed by ear. Start with a small change:
  one part switched off in one variation.
- **No `Sdst` section matrix.** Real arranger styles keep more section detail in
  `Sdst`. These exports do not carry it, so it is not implemented rather than
  implemented and guessed.
- **Timbre is an approximation** in playback, as described above. Dynamics are
  faithful.
- **Retuning and resizing are riskier than velocity.** Velocity is a single byte
  and cannot go wrong structurally. Pitch has to be written twice and can create
  an overlap; length re-serialises the track. Both are covered by tests against the
  real file, but check the result before relying on it on hardware.
- **Adding and removing notes rewrites the whole track.** A note is two events and
  its delta-times are variable-length, so the track is re-emitted and every
  enclosing chunk length is adjusted. Adding also has to pick a track for the
  channel, so a part that exists in a variation the file does not list may put the
  note somewhere unexpected — check the result. Neither has been on hardware.
- **Repeat stops after 50 passes.** A loop that never ends is a bug that sounds like
  a feature, and nobody should come back to a tab still playing. Raise `MAX_LOOPS`
  in `src/audio.js` if you want it to run for ever.
- **The count-in clicks are not part of the style.** They are only in the preview,
  so counting in never changes the file you download.
- **Bulk transforms flatten dynamics by design.** Setting every note in a
  selection to one value removes the original accent pattern within it. Narrow the
  part or pitch range if you only want one drum part. Humanise uses a seeded
  generator, so re-running it is reproducible.
- **Metadata is not rewritten** beyond variation names. Style name, category and
  part names stay as they were.
- **No undo stack.** There is Revert, which discards *all* pending edits, and
  presets, but not a per-gesture undo.

## License

MIT
