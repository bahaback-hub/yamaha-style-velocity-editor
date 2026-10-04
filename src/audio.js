/**
 * Web Audio playback.
 *
 * The point of this engine is not timbre fidelity - the styles reference Genos
 * and PSR sound banks that are not redistributable, so it will never sound like
 * the instrument. The point is that **velocity maps to amplitude**, so setting
 * a note to 40 is audible as a ghost note and 127 as a full hit. That is what
 * makes an edit judgeable by ear instead of by numbers on screen.
 *
 * Scheduling uses the standard lookahead pattern: a coarse interval timer walks
 * a cursor and schedules only the notes falling inside the next window. Queuing
 * four thousand oscillators at once would stall the main thread and make the
 * browser unresponsive precisely when the user is judging something.
 */

const LOOKAHEAD_MS = 25;
const SCHEDULE_WINDOW_S = 0.2;
const MAX_VOICES = 48;

export const TIMBRES = {
  drums: { type: 'percussion', label: 'Drums' },
  bass: { type: 'bass', label: 'Bass' },
  guitar: { type: 'pluck', label: 'Guitar' },
  plucked: { type: 'pluck', label: 'Plucked' },
  pad: { type: 'pad', label: 'Pad' },
  keys: { type: 'keys', label: 'Keys' },
  brass: { type: 'brass', label: 'Brass' },
  voice: { type: 'pad', label: 'Voice' },
  other: { type: 'pluck', label: 'Part' },
};

/** MIDI velocity to linear gain. Squared, because the ear is roughly that steep. */
export function velocityToGain(velocity) {
  const v = Math.max(1, Math.min(127, velocity)) / 127;
  return v * v;
}

const midiToHz = (note) => 440 * 2 ** ((note - 69) / 12);

/**
 * @param {{note: number, at: number, durationTicks: number, velocity: number, channel: number}[]} notes
 */
export class Player {
  /**
   * @param {AudioContext} ctx
   */
  constructor(ctx) {
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 0.9;
    this.master.connect(ctx.destination);
    /** @type {AudioScheduledSourceNode[]} */
    this.active = [];
    this.timer = null;
    this.cursor = 0;
    this.queue = [];
    this.startedAt = 0;
    this.playing = false;
    this.startTick = 0;
    this.speed = 1;
    this.onEnded = null;
    this.voices = 0;
    /** Duration of the scheduled material in seconds, at speed 1. */
    this.duration = 0;
  }

  /**
   * Build the play queue.
   *
   * @param {any[]} notes
   * @param {{tempoMap: any[], timeSignature: any, division: number}} timing
   * @param {(note: any) => number} toSeconds
   * @param {(note: any) => string} familyOf
   * @param {(note: any) => number|{velocity?: number, pitch?: number, durationTicks?: number}} [valuesOf]
   *   optional override, for previewing a pending edit. Returning a bare number is
   *   the common case and means "just the velocity"; returning an object previews
   *   a retune or a new length as well.
   */
  load(notes, timing, toSeconds, familyOf, valuesOf) {
    this.queue = notes
      .map((n) => {
        const raw = valuesOf ? valuesOf(n) : null;
        // Normalise the two accepted shapes into one, so the mapping below does
        // not have to care which the caller used.
        const over = raw !== null && typeof raw === 'object'
          ? raw
          : (raw === null || raw === undefined ? null : { velocity: raw });
        const velocity = over?.velocity ?? n.velocity;
        const pitch = over?.pitch ?? n.note;
        const ticks = over?.durationTicks ?? n.durationTicks;
        return {
          time: toSeconds(n.at),
          note: pitch,
          // A note with no note-off gets a short fallback rather than being
          // dropped: a silent voice reads as "the tool is broken".
          duration: Math.min(ticks > 0 ? toSeconds(n.at + ticks) - toSeconds(n.at) : 0.25, 4),
          family: familyOf(n),
          velocity,
        };
      })
      .sort((a, b) => a.time - b.time);
    this.duration = this.queue.length ? this.queue[this.queue.length - 1].time + 0.5 : 0;
    this.timing = timing;
  }

  setSpeed(multiplier) {
    this.speed = Math.max(0.25, Math.min(2, multiplier));
  }

  /** @param {number} [fromTick] */
  start(fromTick = 0) {
    this.stopSources();
    // Nothing to play: report the end rather than arming a 25 ms timer that
    // would then spin for the life of the page.
    if (this.queue.length === 0) {
      this.playing = false;
      this.onEnded?.();
      return;
    }
    this.playing = true;
    this.startTick = fromTick;
    const fromSeconds = this.timing ? this.tickSeconds(fromTick) : 0;
    this.cursor = this.queue.findIndex((q) => q.time >= fromSeconds);
    if (this.cursor < 0) this.cursor = this.queue.length;
    this.startedAt = this.ctx.currentTime + 0.05;
    this.timer = setInterval(() => this.pump(), LOOKAHEAD_MS);
    this.pump();
  }

  tickSeconds(tick) {
    return tick; // replaced by load(); kept so start() has a fallback
  }

  /** Schedule everything falling inside the lookahead window. */
  pump() {
    if (!this.playing) return;
    const now = this.ctx.currentTime;
    const horizon = now - this.startedAt + SCHEDULE_WINDOW_S * this.speed;
    while (this.cursor < this.queue.length && this.queue[this.cursor].time <= horizon) {
      const item = this.queue[this.cursor++];
      const when = this.startedAt + item.time / this.speed;
      if (when < now) continue; // already in the past
      this.fire(item, when);
    }
    if (this.cursor >= this.queue.length && this.voices === 0) {
      this.stop();
      this.onEnded?.();
    }
  }

  /**
   * @param {{time: number, note: number, duration: number, family: string, velocity: number}} item
   * @param {number} when
   */
  fire(item, when) {
    if (this.voices >= MAX_VOICES) return; // voice stealing: drop rather than stall
    const gain = velocityToGain(item.velocity) * 0.5;
    if (gain < 0.0005) return;
    const timbre = TIMBRES[item.family] ?? TIMBRES.other;
    const nodes =
      timbre.type === 'percussion'
        ? this.percussion(item, when, gain)
        : this.tone(item, when, gain, timbre.type);
    for (const n of nodes) {
      this.active.push(n);
      n.onended = () => {
        this.voices--;
        const i = this.active.indexOf(n);
        if (i >= 0) this.active.splice(i, 1);
      };
    }
    this.voices++;
  }

  /** Percussive: noise burst, pitch sweep, or both, chosen by MIDI note number. */
  percussion(item, when, gain) {
    const ctx = this.ctx;
    const note = item.note;
    const out = ctx.createGain();
    out.connect(this.master);

    const isKick = note === 35 || note === 36;
    const isSnare = note === 37 || note === 38 || note === 39 || note === 40;
    const isOpen = note === 46 || note === 49 || note === 50 || note === 51 || note === 52 || note === 55;
    const isHat = note >= 41 && note <= 46;

    const stopAt = when + (isOpen ? 1.2 : isHat ? 0.06 : isKick ? 0.35 : 0.18);

    // Body: a pitched sweep for kick and toms, a tone for snare.
    if (isKick || (note >= 45 && note <= 50 && !isOpen)) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(130, when);
      osc.frequency.exponentialRampToValueAtTime(44, when + 0.09);
      const g = ctx.createGain();
      g.gain.setValueAtTime(gain * 1.1, when);
      g.gain.exponentialRampToValueAtTime(0.0001, stopAt);
      osc.connect(g).connect(out);
      osc.start(when);
      osc.stop(stopAt + 0.02);
      out.gain.value = 1;
      return [osc];
    }

    // Noise: hats, snares, cymbals.
    const frames = Math.max(1, Math.floor(ctx.sampleRate * 0.5));
    const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const filter = ctx.createBiquadFilter();
    filter.type = isSnare ? 'bandpass' : 'highpass';
    filter.frequency.value = isSnare ? 1800 : isOpen ? 5000 : 8000;
    filter.Q.value = isSnare ? 0.8 : 0.5;
    const g = ctx.createGain();
    const peak = gain * (isSnare ? 0.9 : 0.55);
    g.gain.setValueAtTime(peak, when);
    g.gain.exponentialRampToValueAtTime(0.0001, stopAt);
    src.connect(filter).connect(g).connect(out);
    src.start(when);
    src.stop(stopAt + 0.02);

    if (isSnare) {
      // A snare is noise plus a short tone; without this it reads as a hat.
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(190, when);
      const g2 = ctx.createGain();
      g2.gain.setValueAtTime(gain * 0.5, when);
      g2.gain.exponentialRampToValueAtTime(0.0001, when + 0.12);
      osc.connect(g2).connect(out);
      osc.start(when);
      osc.stop(when + 0.14);
      return [src, osc];
    }
    return [src];
  }

  /** Pitched families: a short synth voice with a family-appropriate envelope. */
  tone(item, when, gain, type) {
    const ctx = this.ctx;
    const hz = midiToHz(item.note);
    const out = ctx.createGain();
    out.connect(this.master);

    const env = ctx.createGain();
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';

    const cfg = {
      bass: { wave: 'sawtooth', cutoff: 900, attack: 0.005, decay: 0.18, sustain: 0.55, release: 0.12 },
      pluck: { wave: 'triangle', cutoff: 3200, attack: 0.002, decay: 0.12, sustain: 0.18, release: 0.18 },
      pad: { wave: 'sine', cutoff: 2200, attack: 0.09, decay: 0.2, sustain: 0.7, release: 0.35 },
      keys: { wave: 'sine', cutoff: 3600, attack: 0.004, decay: 0.3, sustain: 0.3, release: 0.25 },
      brass: { wave: 'square', cutoff: 2400, attack: 0.03, decay: 0.15, sustain: 0.6, release: 0.14 },
    }[type] ?? { wave: 'triangle', cutoff: 2600, attack: 0.005, decay: 0.15, sustain: 0.4, release: 0.2 };

    filter.frequency.value = cfg.cutoff;
    const hold = Math.max(0.06, Math.min(item.duration || 0.25, 2.5));
    const peak = Math.max(0.0001, gain);
    env.gain.setValueAtTime(0.0001, when);
    env.gain.linearRampToValueAtTime(peak, when + cfg.attack);
    env.gain.exponentialRampToValueAtTime(Math.max(0.0001, peak * cfg.sustain), when + cfg.attack + cfg.decay);
    env.gain.setValueAtTime(Math.max(0.0001, peak * cfg.sustain), when + hold);
    env.gain.exponentialRampToValueAtTime(0.0001, when + hold + cfg.release);

    const a = ctx.createOscillator();
    a.type = cfg.wave;
    a.frequency.value = hz;
    const b = ctx.createOscillator();
    b.type = cfg.wave;
    b.frequency.value = hz;
    b.detune.value = 7;
    const mix = ctx.createGain();
    mix.gain.value = 0.6;
    a.connect(mix);
    b.connect(mix);
    mix.connect(filter).connect(env).connect(out);
    const stopAt = when + hold + cfg.release + 0.05;
    a.start(when);
    b.start(when);
    a.stop(stopAt);
    b.stop(stopAt);
    return [a, b];
  }

  stopSources() {
    for (const n of this.active) {
      try {
        n.onended = null;
        n.stop();
      } catch {
        /* already stopped */
      }
    }
    this.active = [];
    this.voices = 0;
  }

  stop() {
    this.playing = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.stopSources();
  }

  /** Playback position in seconds, for the playhead. */
  position() {
    if (!this.playing) return 0;
    return Math.max(0, (this.ctx.currentTime - this.startedAt) * this.speed);
  }
}
