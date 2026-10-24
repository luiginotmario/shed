import { lowerBound, measureAt, type Song } from './tab';

const LOOKAHEAD = 0.15; // seconds of audio scheduled ahead of the clock
const TICK_MS = 25;

/**
 * Plays a song against the AudioContext clock. Song time runs at `speed`
 * relative to real time; everything visual reads `songTime()` so picture,
 * sound and grading share one clock.
 */
export class Transport {
  readonly ctx = new AudioContext({ latencyHint: 'interactive' });
  private master = this.ctx.createGain();
  private guideBus = this.ctx.createGain();
  private clickBus = this.ctx.createGain();
  private song: Song | null = null;
  private strings = new Map<number, AudioBuffer>();
  private timer = 0;
  /** Context time at which song time 0 plays. */
  private zero = 0;
  private scheduledTo = 0;
  private live: AudioScheduledSourceNode[] = [];
  private pausedAt = 0;
  playing = false;
  speed = 1;
  /** Song time where the count-in ends; negative song time is the count-in. */
  countInUntil = 0;
  onEnd?: () => void;

  constructor() {
    const tone = this.ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = 4200;
    this.guideBus.connect(tone).connect(this.master);
    this.clickBus.connect(this.master);
    this.master.gain.value = 0.8;
    this.master.connect(this.ctx.destination);
    this.guideBus.gain.value = 0.55;
    this.clickBus.gain.value = 0.35;
  }

  set guide(on: boolean) {
    this.guideBus.gain.setTargetAtTime(on ? 0.55 : 0, this.ctx.currentTime, 0.02);
  }

  set click(on: boolean) {
    this.clickBus.gain.setTargetAtTime(on ? 0.35 : 0, this.ctx.currentTime, 0.02);
  }

  load(song: Song) {
    this.stop();
    this.song = song;
    this.pausedAt = 0;
  }

  /** Current song time in seconds (at 100% speed). */
  songTime(ctxTime = this.ctx.currentTime): number {
    if (!this.playing) return this.pausedAt;
    return (ctxTime - this.zero) * this.speed;
  }

  /**
   * Song time that was audible at a given performance.now() moment. Uses the
   * output timestamp so it already accounts for output latency.
   */
  songTimeAtPerf(perfMs: number): number {
    if (!this.playing) return this.pausedAt;
    const ts = this.ctx.getOutputTimestamp?.();
    if (ts?.contextTime != null && ts.performanceTime) {
      return this.songTime(ts.contextTime + (perfMs - ts.performanceTime) / 1000);
    }
    return this.songTime(this.ctx.currentTime - (performance.now() - perfMs) / 1000 - this.ctx.outputLatency);
  }

  async play() {
    if (!this.song || this.playing) return;
    await this.ctx.resume();
    const song = this.song;
    if (this.pausedAt >= song.duration - 0.05) this.pausedAt = 0;
    // Count in one bar of the measure we start in, at the playback speed.
    const m = song.measures[measureAt(song, this.pausedAt)];
    const beat = m ? m.dur / m.beats.length : 0.5;
    const countIn = (m?.beats.length ?? 4) * beat;
    const start = this.ctx.currentTime + 0.08;
    this.zero = start + countIn / this.speed - this.pausedAt / this.speed;
    this.countInUntil = this.pausedAt;
    for (let i = 0; i < (m?.beats.length ?? 4); i++) {
      this.clickAt(start + (i * beat) / this.speed, i === 0, true);
    }
    this.scheduledTo = this.pausedAt;
    this.playing = true;
    this.schedule();
    this.timer = window.setInterval(() => this.schedule(), TICK_MS);
  }

  pause() {
    if (!this.playing) return;
    this.pausedAt = Math.max(0, Math.min(this.songTime(), this.song?.duration ?? 0));
    this.halt();
  }

  stop() {
    this.halt();
    this.pausedAt = 0;
  }

  seek(t: number) {
    const was = this.playing;
    this.halt();
    this.pausedAt = Math.max(0, Math.min(t, this.song?.duration ?? 0));
    if (was) void this.play();
  }

  setSpeed(speed: number) {
    if (speed === this.speed) return;
    if (this.playing) {
      const t = this.songTime();
      this.halt();
      this.speed = speed;
      this.pausedAt = t;
      void this.play();
    } else {
      this.speed = speed;
    }
  }

  private halt() {
    this.playing = false;
    clearInterval(this.timer);
    const now = this.ctx.currentTime;
    for (const n of this.live) {
      try {
        n.stop(now + 0.03);
      } catch {
        /* already stopped */
      }
    }
    this.live = [];
  }

  private schedule() {
    const song = this.song;
    if (!song || !this.playing) return;
    const now = this.ctx.currentTime;
    const until = this.songTime(now + LOOKAHEAD);
    if (until <= this.scheduledTo) return;
    const from = this.scheduledTo;

    for (let i = lowerBound(song.notes, from); i < song.notes.length && song.notes[i].t < until; i++) {
      const n = song.notes[i];
      const at = this.zero + n.t / this.speed;
      if (at < now - 0.01) continue;
      this.pluck(n.midi, at, (n.palmMute ? Math.min(n.dur, 0.12) : n.dur) / this.speed, n.dead, n.legato);
    }
    const first = measureAt(song, from);
    for (let mi = first; mi < song.measures.length && song.measures[mi].t < until; mi++) {
      song.measures[mi].beats.forEach((bt, bi) => {
        if (bt >= from && bt < until) this.clickAt(this.zero + bt / this.speed, bi === 0, false);
      });
    }
    this.scheduledTo = until;
    this.live = this.live.filter((n) => (n as AudioScheduledSourceNode & { endsAt?: number }).endsAt! > now);

    if (this.songTime(now) >= song.duration + 0.5) {
      this.pausedAt = song.duration;
      this.halt();
      this.onEnd?.();
    }
  }

  private track(node: AudioScheduledSourceNode, endsAt: number) {
    (node as AudioScheduledSourceNode & { endsAt?: number }).endsAt = endsAt;
    this.live.push(node);
  }

  private clickAt(at: number, accent: boolean, countIn: boolean) {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.frequency.value = accent ? 1760 : 1320;
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(countIn ? 0.9 : accent ? 0.7 : 0.45, at + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, at + 0.05);
    osc.connect(g).connect(countIn ? this.master : this.clickBus);
    osc.start(at);
    osc.stop(at + 0.06);
    this.track(osc, at + 0.06);
  }

  private pluck(midi: number, at: number, dur: number, dead: boolean, legato: boolean) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.string(midi);
    const g = ctx.createGain();
    const ring = dead ? 0.05 : Math.min(Math.max(dur, 0.08), 2.4);
    const peak = legato ? 0.5 : 0.8;
    g.gain.setValueAtTime(peak, at);
    g.gain.setValueAtTime(peak, at + ring);
    g.gain.exponentialRampToValueAtTime(0.0001, at + ring + 0.08);
    src.connect(g).connect(this.guideBus);
    src.start(at);
    src.stop(at + ring + 0.1);
    this.track(src, at + ring + 0.1);
  }

  /** Karplus–Strong plucked string, cached per pitch. */
  private string(midi: number): AudioBuffer {
    const cached = this.strings.get(midi);
    if (cached) return cached;
    const sr = this.ctx.sampleRate;
    const f = 440 * 2 ** ((midi - 69) / 12);
    const len = Math.floor(sr * 2.6);
    const buf = this.ctx.createBuffer(1, len, sr);
    const out = buf.getChannelData(0);
    // The two-tap average adds half a sample of delay, so the line is P − ½.
    const delay = sr / f - 0.5;
    const n = Math.floor(delay);
    const fr = delay - n;
    // Excitation: noise softened by a one-pole lowpass.
    let lp = 0;
    for (let i = 0; i < n + 2; i++) {
      lp += 0.55 * (Math.random() * 2 - 1 - lp);
      out[i] = lp;
    }
    // Lower strings ring longer. Linear interpolation keeps high notes in tune.
    const decay = 0.9965 + Math.min(0.003, (110 / f) * 0.002);
    for (let i = n + 2; i < len; i++) {
      const a = (1 - fr) * out[i - n] + fr * out[i - n - 1];
      const b = (1 - fr) * out[i - n - 1] + fr * out[i - n - 2];
      out[i] = decay * 0.5 * (a + b);
    }
    let max = 0;
    for (let i = 0; i < len; i++) max = Math.max(max, Math.abs(out[i]));
    if (max > 0) for (let i = 0; i < len; i++) out[i] /= max;
    this.strings.set(midi, buf);
    return buf;
  }
}
