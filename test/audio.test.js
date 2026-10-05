/**
 * Player unit tests against a stubbed AudioContext.
 *
 * The browser check can tell whether audio nodes were created, but not why a
 * note was skipped. Driving the engine directly with a fake context pins the
 * scheduling maths - queue construction, the lookahead window, velocity to gain
 * - without a sound card in the loop.
 */

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Player, velocityToGain, TIMBRES } from '../src/audio.js';

/**
 * A context stub that counts everything the engine asks for.
 *
 * `currentTime` is writable on purpose: the region and repeat tests need time to
 * pass, and a real clock would make them either slow or flaky.
 */
function stubContext() {
  const counts = { gains: 0, oscillators: 0, buffers: 0, filters: 0, started: 0, frequencies: [], oscTypes: [] };
  // Every audio time a node was told to start at, so a test can check that a note
  // sounds now rather than some seconds into the future.
  counts.scheduledAt = [];
  const param = () => ({
    value: 0,
    setValueAtTime() {},
    linearRampToValueAtTime() {},
    exponentialRampToValueAtTime() {},
    cancelScheduledValues() {},
  });
  return {
    counts,
    sampleRate: 48000,
    currentTime: 0,
    destination: {},
    createGain() {
      counts.gains++;
      return { gain: param(), connect: (x) => x, disconnect() {} };
    },
    createOscillator() {
      counts.oscillators++;
      // A frequency that records every pitch it is set to, so a test can tell
      // which note was played. The count-in click is the only square wave in the
      // engine, so counting squares counts clicks.
      let hz = 0;
      const freq = {
        get value() { return hz; },
        set value(v) { hz = v; counts.frequencies.push(v); },
        setValueAtTime(v) { hz = v; counts.frequencies.push(v); },
        linearRampToValueAtTime(v) { hz = v; },
        exponentialRampToValueAtTime() {},
        cancelScheduledValues() {},
      };
      return {
        type: '',
        frequency: freq,
        detune: param(),
        connect: (x) => x,
        start(when) {
          counts.started++;
          if (Number.isFinite(when)) counts.scheduledAt.push(when);
          counts.oscTypes.push(this.type);
        },
        stop() {}, onended: null,
      };
    },
    createBufferSource() {
      counts.buffers++;
      return {
        buffer: null, connect: (x) => x,
        start(when) { counts.started++; if (Number.isFinite(when)) counts.scheduledAt.push(when); },
        stop() {}, onended: null,
      };
    },
    createBuffer(_ch, len) {
      return { getChannelData: () => new Float32Array(len) };
    },
    createBiquadFilter() {
      counts.filters++;
      return { type: '', frequency: param(), Q: param(), connect: (x) => x };
    },
  };
}

const toSeconds = (tick) => (tick / 480) * 0.5; // 120 BPM, 480 tpq
const timing = { tempoMap: [{ tick: 0, usPerQuarter: 500000 }], timeSignature: { numerator: 4, denominator: 4 }, division: 480 };

test('velocityToGain is monotonic and squared', () => {
  assert.equal(velocityToGain(127), 1);
  // 0 is clamped up to 1, so it is inaudibly small rather than exactly zero;
  // a note-on with velocity 0 is already filtered out by the parser.
  assert.ok(velocityToGain(0) < 0.0001, `got ${velocityToGain(0)}`);
  assert.ok(velocityToGain(40) < velocityToGain(80));
  assert.ok(velocityToGain(80) < velocityToGain(127));
  // Squared, so half the velocity is a quarter of the amplitude.
  assert.ok(Math.abs(velocityToGain(64) - 0.254) < 0.01, `got ${velocityToGain(64)}`);
});

test('every declared family has a timbre', () => {
  for (const key of Object.keys(TIMBRES)) {
    assert.ok(TIMBRES[key].type, `${key} needs a synth type`);
  }
});

test('load builds a time-ordered queue with sane durations', () => {
  const ctx = stubContext();
  const p = new Player(ctx);
  p.load(
    [
      { note: 40, at: 480, durationTicks: 480, velocity: 90, channel: 1 },
      { note: 36, at: 0, durationTicks: 240, velocity: 100, channel: 1 },
      { note: 42, at: 240, durationTicks: 0, velocity: 70, channel: 1 },
    ],
    timing, toSeconds, () => 'drums', (n) => n.velocity,
  );
  assert.equal(p.queue.length, 3);
  assert.deepEqual(p.queue.map((q) => q.note), [36, 42, 40], 'sorted by time');
  // A note with no note-off falls back rather than being dropped.
  assert.ok(p.queue[1].duration > 0);
  assert.ok(p.duration > 0);
});

test('start schedules the notes inside the lookahead window', () => {
  const ctx = stubContext();
  const p = new Player(ctx);
  p.load(
    Array.from({ length: 8 }, (_, i) => ({
      note: 36 + (i % 3), at: i * 240, durationTicks: 240, velocity: 100, channel: 9,
    })),
    timing, toSeconds, () => 'drums', (n) => n.velocity,
  );
  p.start(0);
  // Only the first window's worth should be created, not all eight.
  assert.ok(ctx.counts.oscillators + ctx.counts.buffers > 0, 'something was scheduled');
  assert.ok(p.voices > 0, 'voices counted');
  p.stop();
});

test('a drum part uses percussion and a pitched part uses oscillators', () => {
  const drums = stubContext();
  const pd = new Player(drums);
  pd.load([{ note: 36, at: 0, durationTicks: 240, velocity: 110, channel: 9 }], timing, toSeconds, () => 'drums', (n) => n.velocity);
  pd.start(0);
  assert.ok(drums.counts.oscillators > 0, 'kick is a pitched sweep');
  pd.stop();

  const bass = stubContext();
  const pb = new Player(bass);
  pb.load([{ note: 40, at: 0, durationTicks: 240, velocity: 110, channel: 1 }], timing, toSeconds, () => 'bass', (n) => n.velocity);
  pb.start(0);
  assert.ok(bass.counts.oscillators >= 2, 'bass is two detuned oscillators');
  assert.ok(bass.counts.filters > 0, 'bass is filtered');
  // The player arms a real interval; leaving it running keeps the node event
  // loop alive and the test runner would never exit.
  pb.stop();
});

test('an empty queue stops instead of hanging', () => {
  const ctx = stubContext();
  const p = new Player(ctx);
  let ended = false;
  p.onEnded = () => { ended = true; };
  p.load([], timing, toSeconds, () => 'drums', (n) => n.velocity);
  p.start(0);
  assert.equal(p.playing, false, 'must not stay playing with nothing to play');
  assert.equal(ended, true, 'end callback fires');
});

test('the velocity override is what gets scheduled', () => {
  // Capture every ramp, not just the decay ones: a percussion voice peaks on
  // setValueAtTime and ramps down afterwards, so watching only one of the two
  // would read the peak as zero.
  const peaks = [];
  const ctx = stubContext();
  const realGain = ctx.createGain.bind(ctx);
  ctx.createGain = () => {
    const g = realGain();
    for (const fn of ['setValueAtTime', 'linearRampToValueAtTime', 'exponentialRampToValueAtTime']) {
      const orig = g.gain[fn].bind(g.gain);
      g.gain[fn] = (v, t) => { peaks.push(v); return orig(v, t); };
    }
    return g;
  };
  const p = new Player(ctx);
  // The note's own velocity is 20; the override asks for 127.
  p.load([{ note: 36, at: 0, durationTicks: 240, velocity: 20, channel: 9 }], timing, toSeconds, () => 'drums', () => 127);
  p.start(0);
  assert.ok(peaks.length > 0, 'a gain ramp happened');
  assert.ok(Math.max(...peaks) > 0.2, `override 127 should dominate, got ${Math.max(...peaks)}`);
  p.stop();

  // And the same note with no override must be quieter.
  peaks.length = 0;
  const quiet = new Player(ctx);
  quiet.load([{ note: 36, at: 0, durationTicks: 240, velocity: 20, channel: 9 }], timing, toSeconds, () => 'drums', (n) => n.velocity);
  quiet.start(0);
  assert.ok(Math.max(...peaks) < 0.2, `original 20 should be quiet, got ${Math.max(...peaks)}`);
  quiet.stop();
});

test('stop releases scheduled nodes and resets the voice count', () => {
  const ctx = stubContext();
  const p = new Player(ctx);
  p.load(
    Array.from({ length: 40 }, (_, i) => ({ note: 36, at: i * 60, durationTicks: 60, velocity: 100, channel: 9 })),
    timing, toSeconds, () => 'drums', (n) => n.velocity,
  );
  p.start(0);
  p.stop();
  assert.equal(p.playing, false);
  assert.equal(p.voices, 0);
  assert.equal(p.active.length, 0);
});

test('the voice cap is honoured so a dense bar cannot flood the context', () => {
  const ctx = stubContext();
  const p = new Player(ctx);
  // 400 simultaneous notes: the cap must keep the created-node count bounded.
  p.load(
    Array.from({ length: 400 }, () => ({ note: 36, at: 0, durationTicks: 480, velocity: 110, channel: 9 })),
    timing, toSeconds, () => 'drums', (n) => n.velocity,
  );
  p.start(0);
  assert.ok(p.voices <= 48, `voices capped, got ${p.voices}`);
  assert.ok(ctx.counts.oscillators + ctx.counts.buffers <= 60,
    `node creation bounded, got ${ctx.counts.oscillators + ctx.counts.buffers}`);
  p.stop();
});

// ---- region, repeat and count-in ---------------------------------------------
// Playing one variation on its own. The stub clock never advances on its own, so
// time is moved by hand - which is exactly what makes the scheduling maths
// checkable: the engine believes currentTime, and a wrong start time shows up as
// notes scheduled in the future that never arrive.

/**
 * Every player built below, so a failed assertion cannot leave its timer running.
 *
 * A player arms a real 25 ms interval, and an assertion that throws before p.stop()
 * never clears it - the test file then hangs with the real timer still alive, and
 * the diagnostics never print. Cleaning up after every test is the only way to see
 * why one failed.
 */
const live = [];
afterEach(() => {
  for (const p of live.splice(0)) {
    try { p.stop(); } catch { /* already stopped */ }
  }
});

/**
 * Run the clock forward, pretending every note finishes as it is scheduled.
 *
 * The stub nodes never fire `onended`, so without this the player waits for ever
 * for its voices to clear and the region never reaches its end - which would make
 * every repeat test pass for the wrong reason.
 */
function advance(p, ctx, steps = 40, step = 0.5) {
  for (let i = 0; i < steps; i++) {
    ctx.currentTime += step;
    p.pump();
    p.voices = 0;
  }
}

/** A player with four notes spread across the file, on a clock we control. */
function regionPlayer({ region, loop = false, countIn = 0 } = {}) {
  const ctx = stubContext();
  const p = new Player(ctx);
  p.load(
    [
      { note: 36, at: 0, durationTicks: 240, velocity: 100, channel: 9 },
      { note: 38, at: 3840, durationTicks: 240, velocity: 100, channel: 9 },
      { note: 42, at: 7680, durationTicks: 240, velocity: 100, channel: 9 },
      { note: 40, at: 11520, durationTicks: 240, velocity: 100, channel: 9 },
    ],
    timing, toSeconds, () => 'drums', (n) => n.velocity,
  );
  p.setRegion(region, loop);
  p.setCountIn(countIn);
  live.push(p);
  return { ctx, p };
}

test('a region plays only the notes inside it', () => {
  const { ctx, p } = regionPlayer({ region: { startTick: 3840, endTick: 7680 } });
  p.start(3840);
  // 3840 ticks is four seconds in, and 7680 is eight, so the region is four
  // seconds long and holds exactly one note.
  assert.equal(p.activeQueue.length, 1, 'one note queued');
  assert.equal(p.activeQueue[0].atTick, 3840);
  p.stop();
});

test('a region is played from its own start, not from the top of the file', () => {
  const ctx = stubContext();
  const p = new Player(ctx);
  live.push(p);
  p.load(
    [
      { note: 36, at: 0, durationTicks: 240, velocity: 100, channel: 9 },
      { note: 42, at: 7680, durationTicks: 240, velocity: 100, channel: 9 },
    ],
    timing, toSeconds, () => 'drums', (n) => n.velocity,
  );
  p.setRegion({ startTick: 7680, endTick: 11520 });
  p.start(7680);
  // The queue is in absolute seconds, so a note eight seconds into the file must
  // be scheduled to sound now. If startedAt is not shifted back by the region's
  // offset, this note lands eight seconds in the future and never plays.
  const times = ctx.counts.scheduledAt;
  assert.ok(times.length > 0, 'a note was scheduled');
  assert.ok(Math.max(...times) < 1.0,
    `the region's first note sounds now, not 8s from now (scheduled at ${Math.max(...times).toFixed(2)})`);
  p.stop();
});

test('a note straddling the start of a region is left out', () => {
  // A note that begins before the region is not clipped into it. Its release is
  // earlier, so playing it would sound a hit from nowhere.
  const { p } = regionPlayer({ region: { startTick: 3840, endTick: 11520 } });
  p.start(3840);
  assert.ok(p.activeQueue.every((q) => q.atTick >= 3840),
    `all notes start inside the region: ${p.activeQueue.map((q) => q.atTick).join(',')}`);
  p.stop();
});

test('repeat starts the region again when it runs out', () => {
  const { ctx, p } = regionPlayer({ region: { startTick: 0, endTick: 960 }, loop: true });
  p.start(0);
  assert.equal(p.loops, 0, 'not yet');
  advance(p, ctx);
  assert.ok(p.loops > 0, `the region came round again, got ${p.loops}`);
  assert.equal(p.playing, true, 'and it is still playing');
});

test('repeat gives up eventually rather than going on for ever', () => {
  const { ctx, p } = regionPlayer({ region: { startTick: 0, endTick: 960 }, loop: true });
  let ended = false;
  p.onEnded = () => { ended = true; };
  p.start(0);
  advance(p, ctx, 500);
  assert.equal(ended, true, 'a loop cannot run for ever');
  assert.ok(p.loops <= 50, `bounded at ${p.loops} repeats`);
});

test('repeat does not count in again on every pass', () => {
  const { ctx, p } = regionPlayer({ region: { startTick: 3840, endTick: 7680 }, loop: true, countIn: 1 });
  p.start(3840);
  // Long enough for the four-second region to run out and come round several times.
  advance(p, ctx, 30, 0.5);
  assert.ok(p.loops > 1, `it repeated, got ${p.loops} repeats`);

  // One bar of count-in is four clicks, and they must be heard once - before the
  // music - not once per pass. The click is the only square wave the engine makes,
  // so counting squares counts clicks.
  const squares = ctx.counts.oscTypes.filter((t) => t === 'square').length;
  assert.equal(squares, 4,
    `the clicks sounded once, not once per repeat (${squares} clicks over ${p.loops} repeats; types: ${JSON.stringify(ctx.counts.oscTypes)})`);
});

test('a count-in places its clicks before the music, one per beat', () => {
  const { ctx, p } = regionPlayer({ region: { startTick: 3840, endTick: 7680 }, countIn: 1 });
  const clicks = p.countInClicksFor(3840);
  assert.equal(clicks.length, 4, `one click per beat in 4/4, got ${clicks.length}`);
  // 3840 ticks is four seconds in, and four quarter beats at 120 BPM is two
  // seconds, so the clicks run from two seconds to half a second before it.
  assert.equal(clicks[3].time, 3.5, 'the last click is half a second before the music');
  assert.ok(clicks.every((c) => c.time < 4), 'every click precedes the music');
  assert.equal(clicks[0].velocity > clicks[1].velocity, true, 'the first beat is accented');
  p.start(3840);
  assert.ok(ctx.counts.oscillators > 0, 'the clicks were scheduled');
});

test('two bars of count-in is eight clicks, all before the music', () => {
  const { p } = regionPlayer({ region: { startTick: 3840, endTick: 7680 }, countIn: 2 });
  const clicks = p.countInClicksFor(3840);
  assert.equal(clicks.length, 8);
  // Two bars is four seconds, and the music starts four seconds in - so the count
  // begins at the very top of the file.
  assert.equal(clicks[0].time, 0, 'two bars before the music');
  assert.ok(clicks.every((c) => c.time < 4));
});

test('no count-in means no clicks', () => {
  const { p } = regionPlayer({ region: { startTick: 3840, endTick: 7680 }, countIn: 0 });
  assert.deepEqual(p.countInClicksFor(3840), []);
});

test('the count-in follows the tempo and the meter of the file', () => {
  const p = new Player(stubContext());
  live.push(p);
  p.load([{ note: 42, at: 7680, durationTicks: 240, velocity: 100, channel: 9 }], timing, toSeconds, () => 'drums', (n) => n.velocity);
  // 6/8 has six beats to a bar, so one bar of count-in is six clicks.
  p.timing = { ...timing, timeSignature: { numerator: 6, denominator: 8 } };
  p.load([{ note: 42, at: 7680, durationTicks: 240, velocity: 100, channel: 9 }], p.timing, toSeconds, () => 'drums', (n) => n.velocity);
  p.setRegion({ startTick: 7680, endTick: 11520 });
  p.setCountIn(1);
  assert.equal(p.countInClicksFor(7680).length, 6, 'six clicks in 6/8');
  // Twice the tempo halves the gap between them.
  const fast = new Player(stubContext());
  live.push(fast);
  fast.load([{ note: 42, at: 7680, durationTicks: 240, velocity: 100, channel: 9 }],
    { ...timing, tempoMap: [{ tick: 0, usPerQuarter: 250000 }] }, toSeconds, () => 'drums', (n) => n.velocity);
  fast.setRegion({ startTick: 7680, endTick: 11520 });
  fast.setCountIn(1);
  const gap = fast.countInClicksFor(7680)[3].time - fast.countInClicksFor(7680)[2].time;
  assert.ok(Math.abs(gap - 0.25) < 0.01, `a quarter at 240 BPM is 0.25s, got ${gap}`);
});

test('without a region the whole file plays, as before', () => {
  const { p } = regionPlayer({ region: null });
  p.start(0);
  assert.equal(p.activeQueue.length, p.queue.length, 'everything is queued');
  p.stop();
});

test('a voice count never goes negative, so the cap keeps working', () => {
  // A pitched part is two oscillators per note and each one reports its own end.
  // Counting one per note let the count fall through zero and keep going, and a
  // negative count never reaches the cap - so the cap stopped capping without
  // anything looking wrong.
  const ctx = stubContext();
  const p = new Player(ctx);
  live.push(p);
  p.load(
    Array.from({ length: 12 }, (_, i) => ({ note: 40, at: i * 60, durationTicks: 60, velocity: 100, channel: 1 })),
    timing, toSeconds, () => 'bass', (n) => n.velocity,
  );
  p.start(0);
  assert.ok(p.voices > 0, 'some voices are live');
  // Every node that ends reports one voice gone.
  for (const n of p.active.slice()) n.onended?.();
  assert.ok(p.voices >= 0, `the count cannot go below zero, got ${p.voices}`);
  assert.equal(p.voices, 0, 'and it lands on zero when everything has ended');
});

test('silence at zero velocity is not scheduled at all', () => {
  const ctx = stubContext();
  const p = new Player(ctx);
  p.load([{ note: 36, at: 0, durationTicks: 240, velocity: 1, channel: 9 }], timing, toSeconds, () => 'drums', () => 0);
  p.start(0);
  // A velocity of 0 has no audible amplitude, so nothing should be created.
  assert.equal(p.voices, 0);
  assert.equal(ctx.counts.oscillators + ctx.counts.buffers, 0);
  p.stop();
});
