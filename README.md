# Yamaha Style Velocity Editor

Edit drum-note **velocity** inside Yamaha `.STY` style files — in the browser,
with no server and no upload.

Built for PSR-A5000, Genos and other arrangers that read SFF2 styles, but the
reader also accepts SFF1.

---

## What it does

1. You drop a `.STY` file onto the page.
2. The tool walks the container, finds the embedded MIDI, and lists every
   note-on event with its channel, pitch and current velocity.
3. You pick which channels and which pitches to touch, choose a velocity from
   1–127, and see exactly how many notes will change before anything happens.
4. You download the edited style.

The original file is never modified. The download is a new file with `-vel`
appended to its name.

## Running it

Open `index.html` in a browser. That is the whole procedure — there is no build
step and no dependency to install for normal use.

If your browser blocks ES modules from `file://`, serve the folder instead:

```sh
npm run serve      # http://localhost:5173
```

## Privacy

The file is read with `FileReader`/`ArrayBuffer` and never leaves the tab. The
page makes no network requests after loading. That is verifiable: open the
browser's network panel and watch it stay empty while you edit.

## How it works

A `.STY` is an **SFF** container: a header followed by chunks, each a 4-character
id and a 4-byte big-endian length.

```
SFF2 header  (magic + header length)
  Smed  <- MIDI data
    MID  <- the performance as authored
    MER  <- the performance as played back
```

Each of `MID` and `MER` holds a Standard MIDI File. A note-on event is three
bytes — `0x9n`, pitch, velocity — so editing velocity means writing one byte.

Three details make this less trivial than it sounds, and all three are covered by
tests:

- **SFF2's header length counts its own four length bytes.** Adding the raw
  value to `8` overshoots by four and lands in the middle of a chunk.
- **Three-character chunk ids are null-padded** on disk, so the id on the wire is
  `MID\0`, not `MID`.
- **MIDI running status** means a track can be a run of bare note numbers with no
  status byte, and meta events carry a variable-length body that has to be
  skipped whole or the parser starts inventing notes.

### Both copies are patched

A style carries the same performance twice. Newer arrangers read `MER`, older
ones read `MID`. Editing only one means the change is silent on half the
hardware in the family, so the tool patches every payload it finds and the test
suite asserts the two stay in sync.

Not every writer puts a standard `MThd` header in the second copy — a `MER`
payload can be a bare run of `MTrk` chunks behind a few proprietary bytes. Those
are read too, via `indexTracksOnly`.

### Nothing is patched silently

If a payload cannot be read at all, the page says so in plain language and
names it, because "the edit did nothing" is otherwise indistinguishable from a
bug. It reports which copy the change reached and warns that the instrument may
still play the untouched copy. The download stays available for the copy that
*was* readable, rather than refusing outright.

### Nothing else is touched

The patcher writes specific bytes into a copy of the input. The container
header, chunk lengths and all metadata are carried over verbatim, because the
player validates the container and rejects a style whose declared lengths
disagree with its contents. A test asserts the output is byte-for-byte the same
length as the input and that only the intended bytes differ.

## Tests

```sh
npm test                    # 19 parser tests
npx playwright install chromium   # once, for the browser check
npm run serve               # in one terminal
node test/ui.e2e.mjs        # 18 browser checks
```

The parser tests run against a synthetic style built in the test file rather
than a real one. That is deliberate: they assert exact byte offsets, so a
regression shows up as a wrong offset rather than a subtly wrong file that only
fails on hardware.

The browser check drives the real page, downloads a file, and re-parses it to
confirm the bytes. It also covers a headerless `MER`, and a payload that cannot
be read at all — the case where the tool has to admit it can only reach one
copy. Plus a regression guard that the original file on disk is unchanged.

## Limitations — please read

- **Untested against a real `.STY` file.** The parser is built from the
  documented SFF/SMF layout and verified against a synthetic fixture, because no
  sample style was available during development. The container handling for
  styles that nest MIDI somewhere other than `Smed` is not covered.
- **Velocity only.** Timbre, length, note events themselves and the pattern
  section are out of scope.
- **It flattens dynamics by design.** Setting every selected note to one value
  removes the original accent pattern within that selection. Narrow the pitch or
  channel range if you only want one drum part.
- **No undo in the page.** Re-download the original if you want to compare.
- **Note ranges are shown C-1 to G9.** Your file may use a subset; the UI
  reports what is actually present rather than assuming GM drum mapping.
- **Metadata is not rewritten.** Name, category and part names stay as they
  were. If you need to rename a style, do that in the arranger's own editor.

## License

MIT
