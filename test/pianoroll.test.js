/**
 * Piano roll and velocity lane tests.
 *
 * The coordinate mapping is the part that cannot be allowed to be approximate:
 * if `xToTick` and `tickToX` disagree by a tick, a dragged note lands on the
 * wrong beat and the tool quietly corrupts the arrangement. These tests assert
 * that they are inverses, and that velocity maps linearly to the lane's height.
 *
 * The transform functions are pure and are tested directly, because they compose -
 * "15% louder then humanise" has to mean the same thing every time.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PianoRoll } from '../src/pianoroll.js';
import { VelocityLane } from '../src/velocity-lane.js';
import {
  scaleVelocity, offsetVelocity, humanizeVelocity, randomVelocity,
  curveVelocity, accentVelocity, clamp,
} from '../src/velocity-lane.js';

// The canvas classes size themselves from `window.devicePixelRatio`, so the test
// environment needs that global even though it never touches a real screen.
globalThis.window ??= { devicePixelRatio: 1 };

// A canvas stand-in: the classes only need a 2d context and a box.
function fakeCanvas(width = 800, height = 300) {
  const calls = [];
  const ctx = new Proxy({}, {
    get: (_t, prop) => {
      if (prop === 'canvas') return null;
      return (...args) => { calls.push([prop, args]); };
    },
    set: () => true,
  });
  return {
    canvas: { clientWidth: width, clientHeight: height, width: 0, height: 0, getContext: () => ctx, style: {}, addEventListener() {} },
    ctx,
    calls,
  };
}

const roll = (w, h) => {
  const { canvas, ctx } = fakeCanvas(w, h);
  const r = new PianoRoll(canvas, {});
  r.ctx = ctx;
  return r;
};

const lane = (w, h) => {
  const { canvas, ctx } = fakeCanvas(w, h);
  const l = new VelocityLane(canvas, {});
  l.ctx = ctx;
  return l;
};

// ---- coordinate mapping -----------------------------------------------------

test('tickToX and xToTick are inverses across the visible range', () => {
  const r = roll();
  r.pxPerTick = 0.5;
  r.scrollTick = 0;
  for (const tick of [0, 1, 7, 480, 1920, 5000, 123456]) {
    assert.equal(r.xToTick(r.tickToX(tick), 0), tick, `tick ${tick}`);
  }
  // With a non-zero scroll origin too.
  r.scrollTick = 7777;
  for (const tick of [7777, 9000, 20000]) {
    assert.equal(r.xToTick(r.tickToX(tick), 0), tick, `scrolled tick ${tick}`);
  }
});

test('xToTick snaps to the grid only when a snap is set', () => {
  const r = roll();
  r.pxPerTick = 1;
  r.scrollTick = 0;
  assert.equal(r.xToTick(1234, 0), 1234, 'free when snapping is off');
  assert.equal(r.xToTick(1234, 240), 1200, 'snapped to the nearest 240');
  assert.equal(r.xToTick(1310, 240), 1200);
  assert.equal(r.xToTick(1320, 240), 1440);
});

test('higher pitch draws higher up, and yToPitch inverts it', () => {
  const r = roll(800, 400);
  r.pxPerSemitone = 10;
  // scrollPitch is the pitch drawn at the top edge, so it is the scroll origin.
  r.scrollPitch = 72;
  assert.ok(r.pitchToY(72) < r.pitchToY(60), 'C5 sits above C3');
  assert.equal(r.pitchToY(60) - r.pitchToY(72), 120, 'exactly 12 semitones apart');
  for (const n of [21, 48, 60, 96]) {
    assert.equal(r.yToPitch(r.pitchToY(n)), n, `pitch ${n} round-trips`);
  }
});

test('yToPitch clamps to the MIDI range instead of running off', () => {
  const r = roll(800, 400);
  r.pxPerSemitone = 10;
  r.scrollPitch = 60;
  assert.equal(r.yToPitch(-5000), 127);
  assert.equal(r.yToPitch(99999), 0);
});

test('pitchRange pads the drawn range around the notes', () => {
  const r = roll(800, 300);
  r.setNotes(
    [{ note: 60, at: 0, durationTicks: 100, velocity: 100, velocityOffset: 1 }, { note: 64, at: 0, durationTicks: 100, velocity: 100, velocityOffset: 2 }],
    { name: 'X', family: 'other', color: '#fff' },
    { division: 480, ticksPerBar: 1920, lengthTicks: 10000 },
  );
  const { low, high } = r.pitchRange;
  assert.ok(low < 60 && high > 64, 'notes are not flush with the edges');
  assert.ok(low >= 0 && high <= 127);
});

test('pitchRange on an empty part falls back rather than collapsing', () => {
  const r = roll();
  r.setNotes([], null, { division: 480, ticksPerBar: 1920, lengthTicks: 0 });
  const { low, high } = r.pitchRange;
  assert.ok(high > low, 'a usable range even with no notes');
});

test('zoom is clamped so it cannot collapse or invert the view', () => {
  const r = roll(800, 300);
  r.lengthTicks = 100000;
  for (let i = 0; i < 60; i++) r.zoomAt(400, 1.5);
  assert.ok(r.pxPerTick <= 6, `horizontal zoom capped, got ${r.pxPerTick}`);
  for (let i = 0; i < 60; i++) r.zoomAt(400, 1 / 1.5);
  assert.ok(r.pxPerTick >= 0.004, `horizontal zoom floor, got ${r.pxPerTick}`);
  for (let i = 0; i < 60; i++) r.zoomVertical(2);
  assert.ok(r.pxPerSemitone <= 40, `vertical zoom capped, got ${r.pxPerSemitone}`);
});

test('zoomAt keeps the tick under the cursor fixed', () => {
  const r = roll(800, 300);
  r.pxPerTick = 0.1;
  r.scrollTick = 0;
  // lengthTicks has to be set: the horizontal bound stops the scroll at the end
  // of the piece, and with no length recorded it clamps to zero and the anchor
  // cannot be honoured. That is the bound doing its job, not a zoom fault.
  r.lengthTicks = 200000;
  const anchorX = 300;
  const before = r.xToTick(anchorX, 0);
  r.zoomAt(anchorX, 2);
  assert.equal(r.xToTick(anchorX, 0), before, 'the anchor tick did not move');
});

test('zoomVertical keeps the middle pitch fixed', () => {
  const r = roll(800, 300);
  // Load a wide range first: the vertical bound is derived from the notes, so on
  // the empty fallback range a zoom-in is legitimately clamped and the centre
  // cannot be held. That clamp is the point of this test on a real part.
  const notes = [];
  for (let n = 24; n <= 96; n++) notes.push(noteAt(n, { note: n, at: 0, durationTicks: 100 }));
  r.setNotes(notes, null, { division: 480, ticksPerBar: 1920, lengthTicks: 10000 });
  r.pxPerSemitone = 10;
  r.scrollPitch = 60;
  const middle = r.yToPitch(150);
  r.zoomVertical(1.5);
  assert.equal(r.yToPitch(150), middle, 'centre pitch did not move');
});
test('zoomVertical still clamps when the range cannot follow the request', () => {
  // With no notes the range is the 36-72 fallback. Zooming in until 20
  // semitones are visible cannot centre on pitch 46, and the view must stay
  // inside the range rather than drift past the top of the part.
  const r = roll(800, 300);
  r.pxPerSemitone = 10;
  r.scrollPitch = 60;
  r.zoomVertical(4);
  const { low, high } = r.pitchRange;
  assert.ok(r.scrollPitch <= high, 'did not scroll above the highest note');
  assert.ok(r.scrollPitch >= low, 'did not scroll below the lowest note');
});

test('revealTick scrolls only when the playhead is off screen', () => {
  const r = roll(800, 300);
  r.pxPerTick = 0.1;
  r.scrollTick = 0;
  r.lengthTicks = 200000;
  r.revealTick(100);            // visible near the left
  assert.equal(r.scrollTick, 0, 'did not scroll for a visible position');
  r.revealTick(150000);         // far away
  assert.ok(r.scrollTick > 0, 'scrolled to follow a distant playhead');
});

test('clampScroll stops the view running off either end', () => {
  const r = roll(800, 300);
  r.pxPerTick = 1;
  r.lengthTicks = 5000;
  r.scrollTick = -99999;
  r.clampScroll();
  assert.ok(r.scrollTick >= -4, 'left edge respected');
  r.scrollTick = 99999;
  r.clampScroll();
  assert.ok(r.scrollTick <= 5000, 'right edge respected');
});

// ---- hit testing ------------------------------------------------------------

const noteAt = (velocityOffset, extra = {}) => ({
  note: 60, at: 1000, durationTicks: 480, velocity: 100, velocityOffset, channel: 9, ...extra,
});

test('noteAt finds the note under the cursor and respects duration width', () => {
  const r = roll(800, 300);
  r.pxPerTick = 0.5;
  r.scrollTick = 0;
  r.pxPerSemitone = 10;
  r.pitchTop = 0;
  r.scrollPitch = 72;
  r.setNotes([noteAt(7)], null, { division: 480, ticksPerBar: 1920, lengthTicks: 5000 });

  assert.equal(r.noteToY ? null : r.noteAt(r.tickToX(1000), r.pitchToY(60))?.velocityOffset, 7);
  // Past the end of the note, nothing.
  assert.equal(r.noteAt(r.tickToX(1000) + 480 * 0.5 + 20, r.pitchToY(60)), null);
  // Wrong pitch, nothing.
  assert.equal(r.noteAt(r.tickToX(1000), r.pitchToY(61)), null);
});

test('velocityOf prefers a pending override over the file value', () => {
  const r = roll();
  const n = noteAt(11, { velocity: 90 });
  r.setNotes([n], null, { division: 480, ticksPerBar: 1920, lengthTicks: 1000 });
  assert.equal(r.velocityOf(n), 90, 'file value when nothing is pending');
  r.setOverrides(new Map([[11, 40]]));
  assert.equal(r.velocityOf(n), 40, 'override wins');
});

test('setNotes clears the selection, since offsets belong to the old part', () => {
  const r = roll();
  r.setNotes([noteAt(3)], null, { division: 480, ticksPerBar: 1920, lengthTicks: 1000 });
  r.selected = r.notes[0];
  r.setNotes([], null, { division: 480, ticksPerBar: 1920, lengthTicks: 0 });
  assert.equal(r.selected, null, 'a stale selection would paint the wrong note');
});

// ---- velocity transforms ----------------------------------------------------

test('clamp keeps velocity inside 1-127', () => {
  assert.equal(clamp(0), 1);
  assert.equal(clamp(200), 127);
  assert.equal(clamp(64), 64);
});

test('scaleVelocity is proportional and clamped to the legal range', () => {
  assert.equal(scaleVelocity(100, 100), 100, '100% is a no-op');
  assert.equal(scaleVelocity(100, 50), 50);
  assert.equal(scaleVelocity(60, 150), 90);
  // 150% of 100 would be 150, which is not a velocity that exists.
  assert.equal(scaleVelocity(100, 150), 127, 'clamped at the top');
  assert.equal(scaleVelocity(100, 200), 127);
  assert.equal(scaleVelocity(100, 0), 1, 'clamped at the bottom');
  // Doubling then halving returns the original where no clamping intervened:
  // 200% then 50% is the exact inverse of one doubling.
  assert.equal(scaleVelocity(scaleVelocity(60, 200), 50), 60);
});

test('offsetVelocity shifts and clamps', () => {
  assert.equal(offsetVelocity(100, 12), 112);
  assert.equal(offsetVelocity(120, 20), 127);
  assert.equal(offsetVelocity(10, -20), 1);
  assert.equal(offsetVelocity(100, 0), 100);
});

test('humanizeVelocity clusters near the original rather than spreading wide', () => {
  // A triangular distribution: most results stay close to the input.
  let near = 0;
  const n = 400;
  for (let i = 0; i < n; i++) {
    const v = humanizeVelocity(80, 12);
    if (Math.abs(v - 80) <= 6) near++;
  }
  assert.ok(near / n > 0.6, `expected most values near the original, got ${near}/${n}`);
  assert.equal(humanizeVelocity(80, 0), 80, 'zero spread is a no-op');
});

test('humanizeVelocity respects its bounds and is deterministic with a given rng', () => {
  for (let i = 0; i < 200; i++) {
    const v = humanizeVelocity(80, 30);
    assert.ok(v >= 1 && v <= 127, `out of range: ${v}`);
  }
  const seq = [0.1, 0.9];
  let k = 0;
  const rng = () => seq[k++ % seq.length];
  const a = humanizeVelocity(80, 20, rng);
  const b = humanizeVelocity(80, 20, rng);
  assert.equal(a, b, 'same rng sequence gives the same result');
});

test('randomVelocity fills the requested band', () => {
  for (let i = 0; i < 200; i++) {
    const v = randomVelocity(0, 90, 110);
    assert.ok(v >= 90 && v <= 110, `out of band: ${v}`);
  }
  assert.equal(randomVelocity(0, 55, 55), 55, 'a zero-width band is exact');
});

test('curveVelocity shifts either side of a pivot independently', () => {
  // Before the pivot gets `below`, after gets `above`.
  assert.equal(curveVelocity(100, 0.1, 0.5, -20, 10), 80);
  assert.equal(curveVelocity(100, 0.9, 0.5, -20, 10), 110);
  assert.equal(curveVelocity(100, 0.5, 0.5, -20, 10), 80, 'the pivot takes the lower branch');
});

test('accentVelocity lifts only what is above the threshold', () => {
  assert.equal(accentVelocity(120, 100, 10), 127, 'accent clamped at the top');
  assert.equal(accentVelocity(90, 100, 10), 90, 'below the threshold, untouched');
  assert.equal(accentVelocity(101, 100, 5), 106);
});

test('transforms compose predictably', () => {
  // Scale then offset by a known amount is the same as doing it by hand.
  assert.equal(offsetVelocity(scaleVelocity(80, 125), 7), 107);
  // Offset then scale is a different result, and that is fine - the point is that
  // it is defined rather than accidental.
  assert.equal(scaleVelocity(offsetVelocity(80, 7), 125), 109);
});

// ---- velocity lane ----------------------------------------------------------

test('lane time mapping matches the roll so the views line up', () => {
  const l = lane(800, 120);
  const r = roll(800, 300);
  l.pxPerTick = r.pxPerTick = 0.4;
  l.scrollTick = r.scrollTick = 1234;
  for (const tick of [1234, 2000, 9000]) {
    assert.equal(l.tickToX(tick), r.tickToX(tick), `tick ${tick} at the same x`);
  }
});

test('lane syncView copies the roll view', () => {
  const l = lane();
  const r = roll();
  r.pxPerTick = 0.33;
  r.scrollTick = 777;
  l.syncView(r);
  assert.equal(l.pxPerTick, 0.33);
  assert.equal(l.scrollTick, 777);
});

test('lane velocityToY and yToVelocity are inverses', () => {
  const l = lane(800, 120);
  for (const v of [1, 40, 64, 100, 127]) {
    assert.equal(l.yToVelocity(l.velocityToY(v)), v, `velocity ${v}`);
  }
  assert.ok(l.velocityToY(127) < l.velocityToY(1), 'loud draws at the top');
});

test('lane yToVelocity clamps rather than leaving the 1-127 range', () => {
  const l = lane(800, 120);
  assert.equal(l.yToVelocity(-999), 127);
  assert.equal(l.yToVelocity(99999), 1);
});

test('lane hit testing picks the nearest bar within a few pixels', () => {
  const l = lane(800, 120);
  l.pxPerTick = 1;
  l.scrollTick = 0;
  l.setNotes([noteAt(5, { at: 500 }), noteAt(6, { at: 900 })], null, { ticksPerBar: 1920 });
  assert.equal(l.noteAt(500)?.velocityOffset, 5);
  assert.equal(l.noteAt(901)?.velocityOffset, 6);
  assert.equal(l.noteAt(700), null, 'between the two notes, nothing');
  assert.equal(l.noteAt(500 + 40), null, 'well past the hit window');
});

test('lane override lookup mirrors the roll', () => {
  const l = lane();
  const n = noteAt(21, { velocity: 100 });
  l.setNotes([n], null, { ticksPerBar: 1920 });
  assert.equal(l.velocityOf(n), 100);
  l.setOverrides(new Map([[21, 33]]));
  assert.equal(l.velocityOf(n), 33);
});

test('lane hides notes far outside the window', () => {
  const l = lane(400, 120);
  l.pxPerTick = 0.1;
  l.scrollTick = 0;
  l.setNotes([noteAt(1, { at: 0 }), noteAt(2, { at: 5_000_000 })], null, { ticksPerBar: 1920 });
  const ids = l.visibleNotes().map((n) => n.velocityOffset);
  assert.ok(ids.includes(1), 'the near note is visible');
  assert.ok(!ids.includes(2), 'the far note is not drawn');
});

// ---- the length handle ------------------------------------------------------

/** One note at a known place, with the roll zoomed so pixels are predictable. */
function rollWithNotes(notes, w = 800, h = 300) {
  const r = roll(w, h);
  r.pxPerTick = 0.1;
  r.scrollTick = 0;
  r.scrollPitch = 72;
  r.setNotes(notes, null, { ticksPerBar: 1920, lengthTicks: 100000 });
  // setNotes calls fit(), which rewrites the scale; put it back.
  r.pxPerTick = 0.1;
  r.scrollTick = 0;
  r.scrollPitch = 72;
  return r;
}

test('the resize handle is found at the drawn trailing edge', () => {
  const n = noteAt(1, { at: 0, note: 60, durationTicks: 100 });
  const r = rollWithNotes([n]);
  const y = r.pitchToY(60) + 1;
  // The note is 100 ticks wide at 0.1 px per tick, so its edge is at x = 10.
  const handle = r.lengthHandleAt(10, y);
  assert.ok(handle, 'the edge is grabbable');
  assert.equal(handle.note, n);
  assert.equal(handle.edgeX, 10);
});

test('the resize handle has a usable grab zone, not a hairline', () => {
  const n = noteAt(1, { at: 0, note: 60, durationTicks: 100 });
  const r = rollWithNotes([n]);
  const y = r.pitchToY(60) + 1;
  assert.ok(r.lengthHandleAt(7, y), 'a few pixels to the left still grabs');
  assert.ok(r.lengthHandleAt(13, y), 'and a few to the right');
  assert.equal(r.lengthHandleAt(2, y), null, 'but the middle of the note does not');
});

test('the resize handle belongs to its own pitch row only', () => {
  const n = noteAt(1, { at: 0, note: 60, durationTicks: 100 });
  const r = rollWithNotes([n]);
  assert.equal(r.lengthHandleAt(10, r.pitchToY(59) + 1), null, 'not on the row above');
  assert.ok(r.lengthHandleAt(10, r.pitchToY(60) + 1), 'but on its own');
});

test('a very short note is still resizable', () => {
  // A 4-tick note is drawn at the minimum width, so the drawn edge is further right
  // than the real one. The handle has to follow what was drawn, or dragging it
  // would snap the note to an unrelated length.
  const n = noteAt(1, { at: 0, note: 60, durationTicks: 4 });
  const r = rollWithNotes([n]);
  const y = r.pitchToY(60) + 1;
  const drawn = Math.max(3, 4 * 0.1);
  assert.equal(r.lengthHandleAt(drawn, y).note, n);
});

test('the resize handle ignores notes outside the window', () => {
  const n = noteAt(1, { at: 9_000_000, note: 60, durationTicks: 100 });
  const r = rollWithNotes([n]);
  assert.equal(r.lengthHandleAt(10, r.pitchToY(60) + 1), null);
});
