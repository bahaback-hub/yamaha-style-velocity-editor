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
// A loop that never stops is a bug that sounds like a feature, and a player who
// walks away from the tab would never find the end of it. Fifty passes is far more
// than anyone is listening for, and the counter is reported in the status line.
const MAX_LOOPS = 50;

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
    // Region playback: which part of the file is being played, and whether to
    // start it again when it runs out. Null start means the whole file.
    this.region = null;
    this.loop = false;
    /** Bars of click before the music starts. */
    this.countIn = 0;
    /** Signed count of how many times the region has been played through. */
    this.loops = 0;
  }

  /**
   * Play only part of the file, optionally repeating it.
   *
   * This is what makes a variation audible on its own. The boundaries come from
   * the file's markers, so "play Main B" means the bars the style itself calls
   * Main B - not a guess, and not whatever happens to be visible on screen.
   *
   * @param {{startTick?: number, endTick?: number}|null} region
   * @param {boolean} [loop]
   */
  setRegion(region, loop = false) {
    this.region = region ?? null;
    this.loop = Boolean(loop);
    this.loops = 0;
  }

  /**
   * Bars of click to play before the music.
   *
   * Scheduled as notes rather than as a separate click track, so they go through
   * the same voice pool and are cut off by stop() like everything else.
   *
   * @param {number} bars 0, 1 or 2
   * @param {number} [ticksPerBar]
   */
  setCountIn(bars, ticksPerBar = 1920) {
    this.countIn = Math.max(0, Math.min(2, Math.round(bars)));
    this.countInTicksPerBar = ticksPerBar;
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
    // Kept in ticks as well as seconds: the region is expressed in ticks, and a
    // note straddling a boundary has to be judged in ticks to be included or not.
    this.toSeconds = toSeconds;
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
          atTick: n.at,
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

  /**
   * @param {number} [fromTick]
   */
  start(fromTick = 0) {
    this.stopSources();
    const region = this.region;

    // Only what falls inside the region, and only what starts inside it. A note
    // that begins before the region is left out rather than clipped: its release
    // is somewhere earlier, so playing it would sound a drum hit out of nowhere.
    const items = region
      ? this.queue.filter((q) => q.atTick >= region.startTick
        && (region.endTick == null || q.atTick < region.endTick))
      : this.queue;

    // The count-in lives on the queue as ordinary click notes placed before the
    // music, so it is scheduled by the same lookahead, cut off by the same stop(),
    // and slowed down by the same speed control. Nothing else has to know it is
    // there. Position is in seconds, which is what the queue is sorted by, and
    // `fromTick` is converted the same way - mixing the two units is how a count-in
    // ends up an hour long.
    const musicFrom = this.toSeconds ? this.toSeconds(fromTick) : 0;
    const clicks = this.countIn > 0 && this.toSeconds ? this.#countInClicks(musicFrom) : [];
    const withCountIn = clicks.length
      ? [...clicks, ...items].sort((a, b) => a.time - b.time)
      : items;
    this.countInUntil = this.countIn > 0 ? musicFrom : 0;
    this.musicFromSeconds = musicFrom;

    if (withCountIn.length === 0) {
      this.playing = false;
      this.onEnded?.();
      return;
    }
    this.playing = true;
    this.startTick = fromTick;
    this.regionFrom = region ? region.startTick : 0;
    this.regionTo = region && region.endTick != null ? region.endTick : null;
    this.activeQueue = withCountIn;
    // The clock behind `startedAt` starts when playback does, but the queue is in
    // seconds from the top of the file. The two are lined up by `origin`: the file
    // second that corresponds to "now".
    //
    // With a count-in that is the first click, not the music. Anchoring on the
    // music instead would put every click before "now" - and a click before now is
    // dropped as late, so the count-in would be silent.
    this.originSeconds = clicks.length ? clicks[0].time : musicFrom;
    // Counting in starts at the first click; otherwise start where the caller asked.
    this.cursor = this.countIn > 0
      ? 0
      : withCountIn.findIndex((q) => q.time >= musicFrom);
    if (this.cursor < 0) this.cursor = withCountIn.length;
    this.loops = 0;
    this.startedAt = this.ctx.currentTime + 0.05 - this.originSeconds / this.speed;
    this.timer = setInterval(() => this.pump(), LOOKAHEAD_MS);
    this.pump();
  }

  /**
   * One click per beat for the count-in bars, the first beat accented.
   *
   * Placed from the music's own start backwards, so the click lands exactly on
   * the beat it is counting rather than approximately.
   */
  #countInClicks(musicFrom) {
    const usPerQuarter = this.timing?.tempoMap?.[0]?.usPerQuarter ?? 500000;
    const beatsPerBar = this.timing?.timeSignature?.numerator ?? 4;
    // A quarter note is a quarter note whatever the meter says the bar holds, so
    // the beat length is the tempo alone - the denominator belongs to the bar, not
    // to the beat. In 6/8 at 120 the click is still half a second.
    const beatSeconds = usPerQuarter / 1e6;
    const clicks = [];
    for (let bar = this.countIn - 1; bar >= 0; bar--) {
      for (let beat = 0; beat < beatsPerBar; beat++) {
        clicks.push({
          time: musicFrom - (bar * beatsPerBar + (beatsPerBar - beat)) * beatSeconds,
          note: beat === 0 ? 76 : 77, // a high woodblock: accented vs plain
          duration: beatSeconds * 0.5,
          // 'drums' is a family name, not a timbre type: the family is what decides which
          // instrument is used, and an unknown family silently falls back to the
          // default synth - so a click written as "percussion" would come out as a
          // plain tone rather than a click.
          family: 'drums',
          velocity: beat === 0 ? 110 : 80,
          isCountIn: true,
        });
      }
    }
    return clicks.filter((c) => c.time >= 0);
  }

  /**
   * Where the count-in clicks would fall, for the browser tests.
   *
   * Answers the same question the scheduler does, by calling the same code, so a
   * test asking "would the clicks be before the music" cannot be satisfied by a
   * second implementation that happens to agree with itself.
   */
  countInClicksFor(fromTick = 0) {
    if (this.countIn <= 0 || !this.toSeconds) return [];
    return this.#countInClicks(this.toSeconds(fromTick));
  }

  /** Start again at the beginning of the region, which is what looping means. */
  restart() {
    this.stopSources();
    this.loops++;
    // From the region, not from zero - and never the count-in again: counting in
    // before every repeat would make the loop unusable.
    const fromSeconds = this.toSeconds ? this.toSeconds(this.regionFrom ?? 0) : 0;
    this.cursor = this.activeQueue.findIndex((q) => q.time >= fromSeconds && !q.isCountIn);
    if (this.cursor < 0) this.cursor = this.activeQueue.length;
    this.originSeconds = fromSeconds;
    this.startedAt = this.ctx.currentTime + 0.05 - fromSeconds / this.speed;
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
    while (this.cursor < this.activeQueue.length && this.activeQueue[this.cursor].time <= horizon) {
      const item = this.activeQueue[this.cursor++];
      const when = this.startedAt + item.time / this.speed;
      if (when < now) continue; // already in the past
      this.fire(item, when);
    }
    if (this.cursor < this.activeQueue.length || this.voices > 0) return;

    // The region has run out. With loop on, start it again rather than stopping -
    // but only once the last note has actually finished, otherwise the repeat
    // truncates the tail.
    if (this.loop && this.region && this.loops < MAX_LOOPS) {
      this.restart();
      return;
    }
    this.stop();
    this.onEnded?.();
  }

  /**
   * @param {{time: number, note: number, duration: number, family: string, velocity: number}} item
   * @param {number} when
   */
  fire(item, when) {
    // The cap is on nodes, because that is what the audio context is actually
    // asked for - a pitched voice is two oscillators.
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
    // Counted per node, not per note. A pitched voice is two detuned oscillators
    // and each one reports its own end, so counting one per note let the count
    // drift downwards until it went negative - and a negative count never reaches
    // MAX_VOICES, so the cap quietly stopped capping anything.
    this.voices += nodes.length;
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

    // A count-in click: a short pitched blip, not a noise burst. It has to be
    // distinguishable from the hi-hat the style itself is playing, or counting in
    // over a drum part just makes the hats harder to hear.
    if (item.isCountIn) {
      const osc = ctx.createOscillator();
      osc.type = 'square';
      osc.frequency.value = midiToHz(note);
      const g = ctx.createGain();
      g.gain.setValueAtTime(gain * 0.5, when);
      g.gain.exponentialRampToValueAtTime(0.0001, when + 0.04);
      osc.connect(g).connect(out);
      osc.start(when);
      osc.stop(when + 0.05);
      out.gain.value = 1;
      return [osc];
    }

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

  /** Which part of the file is playing, as a tick range, for the status line. */
  playingRegion() {
    if (!this.playing || !this.region) return null;
    return {
      startTick: this.regionFrom ?? 0,
      endTick: this.regionTo,
      loops: this.loops,
    };
  }
}
