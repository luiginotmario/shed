import type { Grade, Judgement } from './coach';
import { lowerBound, measureAt, noteName, type Hit, type Note, type Song } from './tab';

const BONE = '236, 228, 212';
const NICKEL = '189, 183, 172';
const PILOT = '227, 162, 74';
const GROUND = '#11100e';

/** String gauges, thin high e to thick low E, in CSS px. */
const GAUGE = [1, 1.2, 1.5, 1.9, 2.4, 2.9, 3.3];

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

interface Flash {
  at: number;
  grade: Grade;
  offset: number;
}

/**
 * Six string lanes scrolling right to left into the nut. Notes are fret
 * numbers on their string, sustain trails behind them, and a struck string
 * shimmers between nut and bridge.
 */
export class Highway {
  private ctx: CanvasRenderingContext2D;
  private w = 0;
  private h = 0;
  private dpr = 1;
  private ring: number[] = [];
  private flashes: Flash[] = [];
  private lastT = 0;
  private gradeOf = new Map<Note, Grade>();

  constructor(
    private canvas: HTMLCanvasElement,
    private song: Song,
  ) {
    this.ctx = canvas.getContext('2d')!;
    this.ring = song.tuning.map(() => 0);
    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
  }

  private resize() {
    const r = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(2, devicePixelRatio || 1);
    this.w = r.width;
    this.h = r.height;
    this.canvas.width = Math.round(r.width * this.dpr);
    this.canvas.height = Math.round(r.height * this.dpr);
  }

  get nutX() {
    return Math.round(Math.min(260, Math.max(96, this.w * 0.2)));
  }

  /** Pixels per song-second; wider screens see further ahead. */
  get pps() {
    return Math.min(280, Math.max(170, this.w / 5));
  }

  private laneY(s: number) {
    // Lanes stay a comfortable distance apart and center on tall screens.
    const n = this.song.tuning.length;
    const room = this.h - 104;
    const gap = Math.min(76, room / n);
    return 64 + (room - gap * n) / 2 + gap * (s + 0.5);
  }

  judge(j: Judgement) {
    for (const n of j.hit.notes) this.gradeOf.set(n, j.grade);
    this.flashes.push({ at: performance.now(), grade: j.grade, offset: j.offset });
    if (this.flashes.length > 4) this.flashes.shift();
  }

  clearGrades() {
    this.gradeOf.clear();
    this.flashes = [];
  }

  /** Strings whose notes crossed the nut since the last frame start ringing. */
  private strike(t: number, playing: boolean) {
    if (playing && t > this.lastT && t - this.lastT < 0.25) {
      const notes = this.song.notes;
      for (let i = lowerBound(notes, this.lastT); i < notes.length && notes[i].t <= t; i++) {
        this.ring[notes[i].string] = notes[i].dead ? 0.4 : 1;
      }
    }
    this.lastT = t;
  }

  draw(t: number, playing: boolean, countIn: number | null) {
    const { ctx, w, h, dpr } = this;
    if (!w || !h) return;
    this.strike(t, playing);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const nut = this.nutX, pps = this.pps;
    const x = (time: number) => nut + (time - t) * pps;
    const t0 = t - nut / pps - 0.5;
    const t1 = t + (w - nut) / pps + 0.5;
    const top = this.laneY(0) - 22, bottom = this.laneY(this.song.tuning.length - 1) + 22;

    this.drawMeasures(x, t0, t1, top, bottom);
    this.drawStrings(nut, w);
    this.drawSustains(x, t0, t1, nut);
    this.drawNotes(x, t0, t1, nut);
    this.drawNut(nut, top, bottom);
    this.drawFlashes(nut, top);
    if (countIn != null) this.drawCountIn(nut, countIn);

    for (let i = 0; i < this.ring.length; i++) this.ring[i] *= 0.88;
  }

  private drawMeasures(x: (t: number) => number, t0: number, t1: number, top: number, bottom: number) {
    const { ctx } = this;
    const ms = this.song.measures;
    ctx.font = '500 10px "Geist Mono", monospace';
    ctx.textBaseline = 'alphabetic';
    for (let i = measureAt(this.song, t0); i < ms.length && ms[i].t < t1; i++) {
      const m = ms[i];
      const mx = Math.round(x(m.t)) + 0.5;
      ctx.fillStyle = `rgba(${BONE}, 0.07)`;
      for (const b of m.beats.slice(1)) ctx.fillRect(Math.round(x(b)), top + 6, 1, bottom - top - 12);
      ctx.fillStyle = `rgba(${BONE}, ${m.marker ? 0.22 : 0.13})`;
      ctx.fillRect(mx - 0.5, top - 6, 1, bottom - top + 12);
      ctx.fillStyle = `rgba(${BONE}, 0.3)`;
      ctx.fillText(String(i + 1), mx + 5, top + 4);
      if (m.marker) {
        ctx.save();
        ctx.font = '500 11px "Geist", sans-serif';
        ctx.fillStyle = `rgba(${BONE}, 0.62)`;
        ctx.fillText(m.marker.toUpperCase(), mx + 5, top - 12);
        ctx.restore();
      }
    }
  }

  private drawStrings(nut: number, w: number) {
    const { ctx } = this;
    const n = this.song.tuning.length;
    for (let s = 0; s < n; s++) {
      const y = this.laneY(s);
      const ring = this.ring[s];
      const g = GAUGE[Math.min(s, GAUGE.length - 1)];
      // Behind the nut the string is dead; ahead of it, it rings when struck.
      ctx.fillStyle = `rgba(${NICKEL}, 0.16)`;
      ctx.fillRect(0, y - g / 2, nut, g);
      ctx.strokeStyle = `rgba(${NICKEL}, ${0.34 + ring * 0.5})`;
      ctx.lineWidth = g + ring * 0.8;
      ctx.beginPath();
      if (ring > 0.04 && !reduceMotion.matches) {
        const amp = ring * 2.2;
        const phase = performance.now() / 18 + s;
        for (let px = nut; px <= w; px += 8) {
          const env = Math.sin((Math.PI * (px - nut)) / (w - nut));
          const yy = y + Math.sin(phase + px * 0.02) * amp * env;
          if (px === nut) ctx.moveTo(px, yy);
          else ctx.lineTo(px, yy);
        }
      } else {
        ctx.moveTo(nut, y);
        ctx.lineTo(w, y);
      }
      ctx.stroke();
    }
  }

  private drawSustains(x: (t: number) => number, t0: number, t1: number, nut: number) {
    const { ctx } = this;
    const notes = this.song.notes;
    // Long notes can start before the window, so look back a little further.
    for (let i = lowerBound(notes, t0 - 4); i < notes.length && notes[i].t < t1; i++) {
      const n = notes[i];
      if (n.dur < 0.3 || n.dead) continue;
      const a = Math.max(x(n.t) + 14, nut), b = x(n.t + n.dur);
      if (b <= a) continue;
      ctx.fillStyle = `rgba(${BONE}, 0.14)`;
      ctx.fillRect(a, this.laneY(n.string) - 2, b - a, 4);
    }
  }

  private drawNotes(x: (t: number) => number, t0: number, t1: number, nut: number) {
    const { ctx } = this;
    const notes = this.song.notes;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let i = lowerBound(notes, t0); i < notes.length && notes[i].t < t1; i++) {
      const n = notes[i];
      const nx = x(n.t), ny = this.laneY(n.string);
      const label = n.dead ? '×' : String(n.fret);
      const wide = label.length > 1 ? 34 : 27;
      const grade = this.gradeOf.get(n);
      const past = nx < nut - 2;
      // Past notes fade out with distance behind the nut.
      const fade = past ? Math.max(0.12, 1 - (nut - nx) / nut) : 1;

      let fill: string | null = `rgba(${BONE}, ${0.95 * fade})`;
      let text = GROUND;
      let stroke: string | null = null;
      if (n.legato) {
        // Hammer-ons and pull-offs aren't picked: outline only.
        fill = `rgba(17, 16, 14, ${fade})`;
        stroke = `rgba(${BONE}, ${0.7 * fade})`;
        text = `rgba(${BONE}, ${0.85 * fade})`;
      }
      if (grade === 'early' || grade === 'late') {
        fill = `rgba(${PILOT}, ${0.95 * fade})`;
        stroke = null;
        text = GROUND;
      } else if (grade === 'miss') {
        fill = `rgba(17, 16, 14, ${fade})`;
        stroke = `rgba(${BONE}, ${0.35 * fade})`;
        text = `rgba(${BONE}, ${0.4 * fade})`;
      }

      ctx.beginPath();
      ctx.roundRect(nx - wide / 2, ny - 13, wide, 26, 6);
      if (fill) {
        ctx.fillStyle = fill;
        ctx.fill();
      }
      if (stroke) {
        ctx.strokeStyle = stroke;
        ctx.lineWidth = 1.25;
        ctx.stroke();
      }
      ctx.fillStyle = text;
      ctx.font = '500 15px "Geist Mono", monospace';
      ctx.fillText(label, nx, ny + 0.5);
    }
    ctx.textAlign = 'start';
  }

  private drawNut(nut: number, top: number, bottom: number) {
    const { ctx } = this;
    const glow = Math.max(...this.ring);
    // The past sits under a veil so the eye stays on what's coming.
    const veil = ctx.createLinearGradient(0, 0, nut, 0);
    veil.addColorStop(0, 'rgba(17, 16, 14, 0.75)');
    veil.addColorStop(1, 'rgba(17, 16, 14, 0.15)');
    ctx.fillStyle = veil;
    ctx.fillRect(0, top - 8, nut - 3, bottom - top + 16);
    if (glow > 0.05) {
      ctx.fillStyle = `rgba(${BONE}, ${glow * 0.09})`;
      ctx.fillRect(nut - 14, top - 8, 28, bottom - top + 16);
    }
    ctx.fillStyle = `rgb(${BONE})`;
    ctx.beginPath();
    ctx.roundRect(nut - 3, top - 10, 6, bottom - top + 20, 2);
    ctx.fill();
    // Open-string names, like the letters at the start of a tab staff.
    ctx.font = '500 11px "Geist Mono", monospace';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    for (let s = 0; s < this.song.tuning.length; s++) {
      const y = this.laneY(s);
      ctx.fillStyle = GROUND;
      ctx.fillRect(6, y - 8, 28, 16);
      ctx.fillStyle = `rgba(${BONE}, 0.55)`;
      ctx.fillText(noteName(this.song.tuning[s]), 20, y + 0.5);
    }
    ctx.textAlign = 'start';
  }

  private drawFlashes(nut: number, top: number) {
    const { ctx } = this;
    const now = performance.now();
    this.flashes = this.flashes.filter((f) => now - f.at < 900);
    const f = this.flashes[this.flashes.length - 1];
    if (!f) return;
    const k = (now - f.at) / 900;
    const alpha = k < 0.15 ? k / 0.15 : 1 - Math.max(0, (k - 0.5) / 0.5);
    const rise = reduceMotion.matches ? 0 : 8 * (1 - (1 - k) ** 3);
    const ms = Math.round(Math.abs(f.offset) * 1000);
    const text = f.grade === 'good' ? 'on time' : f.grade === 'miss' ? 'missed' : `${f.grade} ${ms}ms`;
    ctx.font = '500 12px "Geist", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle =
      f.grade === 'good' ? `rgba(${BONE}, ${alpha})` : f.grade === 'miss' ? `rgba(${BONE}, ${alpha * 0.5})` : `rgba(${PILOT}, ${alpha})`;
    ctx.fillText(text, nut, top - 22 - rise);
    ctx.textAlign = 'start';
  }

  private drawCountIn(nut: number, beatsLeft: number) {
    const { ctx } = this;
    const mid = (this.laneY(0) + this.laneY(this.song.tuning.length - 1)) / 2;
    ctx.font = '500 56px "Geist Mono", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = `rgba(${BONE}, 0.9)`;
    ctx.fillText(String(beatsLeft), nut + Math.min(220, this.w * 0.25), mid);
    ctx.textAlign = 'start';
  }

  /** The next hit after t, for "next notes in …" during long rests. */
  nextHit(t: number): Hit | undefined {
    return this.song.hits[lowerBound(this.song.hits, t)];
  }
}
