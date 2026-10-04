/**
 * Player unit tests against a stubbed AudioContext.
 *
 * The browser check can tell whether audio nodes were created, but not why a
 * note was skipped. Driving the engine directly with a fake context pins the
 * scheduling maths - queue construction, the lookahead window, velocity to gain
 * - without a sound card in the loop.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Player, velocityToGain, TIMBRES } from '../src/audio.js';

/** A context stub that counts everything the engine asks for. */
function stubContext() {
  const counts = { gains: 0, oscillators: 0, buffers: 0, filters: 0, started: 0 };
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
      return {
        type: '', frequency: param(), detune: param(),
        connect: (x) => x, start() { counts.started++; }, stop() {}, onended: null,
      };
    },
    createBufferSource() {
      counts.buffers++;
      return { buffer: null, connect: (x) => x, start() { counts.started++; }, stop() {}, onended: null };
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
