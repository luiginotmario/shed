import { lowerBound, noteName, type Note, type Song } from './tab';

const BONE = '236, 228, 212';
const NICKEL = '189, 183, 172';
const PILOT = '227, 162, 74';
const GROUND = '#11100e';
const GAUGE = [1, 1.2, 1.5, 1.9, 2.4, 2.9, 3.3];
const INLAYS = [3, 5, 7, 9, 15, 17, 19, 21];

/**
 * The neck as you see it looking down at a right-handed guitar: tuning pegs
 * (the nut) on the left, frets counting up to the right, thickest string on
 * top. The note to play now is a lit dot where the fingertip goes; the next
 * one is an outline so you can get ready.
 */
export class Fretboard {
  private ctx: CanvasRenderingContext2D;
  private w = 0;
  private h = 0;
  private dpr = 1;
  private frets: number;
  tabOrder = false;

  constructor(
    private canvas: HTMLCanvasElement,
    private song: Song,
  ) {
    this.ctx = canvas.getContext('2d')!;
    const highest = song.notes.reduce((m, n) => Math.max(m, n.fret), 0);
    this.frets = Math.min(22, Math.max(12, highest + 1));
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

  private get left() {
    return 92;
  }

  /** x of fret wire n, spaced like a real neck (each fret 2^(-1/12) narrower). */
  private fretX(n: number) {
    const right = this.w - 20;
    const pos = (k: number) => 1 - 2 ** (-k / 12);
    return this.left + ((right - this.left) * pos(n)) / pos(this.frets);
  }

  /** Where the fingertip goes: just behind the fret wire, not on it. */
  private fingerX(fret: number) {
    return this.fretX(fret - 1) + 0.62 * (this.fretX(fret) - this.fretX(fret - 1));
  }

  private stringY(string: number) {
    const n = this.song.tuning.length;
    const row = this.tabOrder ? string : n - 1 - string;
    const top = 24, bottom = this.h - 36;
    return top + ((bottom - top) * row) / (n - 1);
  }

  draw(t: number) {
    const { ctx, w, h, dpr } = this;
    if (!w || !h) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const notes = this.song.notes;
    // Now: anything sounding, or about to in the next blink. Next: the following stroke.
    const now: Note[] = [];
    const lead = 0.08;
    for (let i = Math.max(0, lowerBound(notes, t - 4)); i < notes.length && notes[i].t <= t + lead; i++) {
      const n = notes[i];
      if (n.t + Math.max(n.dur, 0.15) >= t) now.push(n);
    }
    const ni = lowerBound(notes, t + lead + 0.001);
    const next: Note[] = [];
    if (ni < notes.length) {
      const nt = notes[ni].t;
      for (let i = ni; i < notes.length && notes[i].t - nt < 0.015; i++) next.push(notes[i]);
    }

    const top = this.stringY(this.tabOrder ? 0 : this.song.tuning.length - 1);
    const bottom = this.stringY(this.tabOrder ? this.song.tuning.length - 1 : 0);
    const nut = this.fretX(0);
    const end = this.fretX(this.frets);

    // Wood.
    ctx.fillStyle = '#1a1612';
    ctx.fillRect(nut, top - 12, end - nut, bottom - top + 24);

    // Inlay dots: the same markers as on your guitar, so you can find frets 3, 5, 7…
    const mid = (top + bottom) / 2;
    ctx.fillStyle = `rgba(${BONE}, 0.16)`;
    for (const f of INLAYS) {
      if (f > this.frets) continue;
      ctx.beginPath();
      ctx.arc((this.fretX(f - 1) + this.fretX(f)) / 2, mid, 5, 0, Math.PI * 2);
      ctx.fill();
    }
    if (this.frets >= 12) {
      const x12 = (this.fretX(11) + this.fretX(12)) / 2, gap = (bottom - top) / 4;
      for (const y of [mid - gap, mid + gap]) {
        ctx.beginPath();
        ctx.arc(x12, y, 5, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Fret wires and their numbers.
    ctx.font = '500 11px "Geist Mono", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const lit = new Set(now.filter((n) => n.fret > 0).map((n) => n.fret));
    for (let f = 1; f <= this.frets; f++) {
      const x = this.fretX(f);
      ctx.fillStyle = `rgba(${NICKEL}, 0.35)`;
      ctx.fillRect(x - 1, top - 12, 2, bottom - top + 24);
      ctx.fillStyle = lit.has(f) ? `rgb(${BONE})` : `rgba(${BONE}, ${INLAYS.includes(f) || f === 12 ? 0.55 : 0.3})`;
      ctx.fillText(String(f), (this.fretX(f - 1) + x) / 2, bottom + 18);
    }

    // Strings, thickest drawn thickest; the ones in use light up.
    const active = new Set(now.map((n) => n.string));
    for (let s = 0; s < this.song.tuning.length; s++) {
      const y = this.stringY(s);
      const g = GAUGE[Math.min(s, GAUGE.length - 1)];
      ctx.fillStyle = active.has(s) ? `rgba(${BONE}, 0.85)` : `rgba(${NICKEL}, 0.5)`;
      ctx.fillRect(nut - 26, y - g / 2, end - nut + 26, g);
      // String number and name, matching the lanes above.
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'right';
      ctx.font = '500 13px "Geist Mono", monospace';
      ctx.fillStyle = active.has(s) ? `rgb(${BONE})` : `rgba(${BONE}, 0.7)`;
      ctx.fillText(String(s + 1), 22, y + 0.5);
      ctx.textAlign = 'left';
      ctx.font = '400 11px "Geist Mono", monospace';
      ctx.fillStyle = `rgba(${BONE}, 0.5)`;
      const name = noteName(this.song.tuning[s]);
      ctx.fillText(s === 0 && name === 'E' ? 'e' : name, 28, y + 0.5);
    }

    // The nut, where the tuning-peg end of the neck is.
    ctx.fillStyle = `rgb(${BONE})`;
    ctx.fillRect(nut - 3, top - 14, 6, bottom - top + 28);
    ctx.font = '400 10px "Geist", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = `rgba(${BONE}, 0.45)`;
    ctx.fillText('pegs', nut - 14, bottom + 18);

    const nowKeys = new Set(now.map((n) => `${n.string}:${n.fret}`));
    for (const n of next) if (!nowKeys.has(`${n.string}:${n.fret}`)) this.marker(n, false);
    for (const n of now) this.marker(n, true);
    ctx.textAlign = 'start';
  }

  private marker(n: Note, now: boolean) {
    const { ctx } = this;
    const y = this.stringY(n.string);
    const open = n.fret === 0;
    // Open strings are played without a finger: mark them left of the nut.
    const x = open ? this.fretX(0) - 16 : this.fingerX(n.fret);
    const r = 10.5;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    if (now) {
      ctx.fillStyle = n.dead ? `rgb(${PILOT})` : `rgb(${BONE})`;
      ctx.fill();
    } else {
      ctx.fillStyle = GROUND;
      ctx.fill();
      ctx.strokeStyle = `rgba(${BONE}, 0.7)`;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    ctx.font = '600 12px "Geist Mono", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = now ? GROUND : `rgba(${BONE}, 0.85)`;
    ctx.fillText(n.dead ? '×' : String(n.fret), x, y + 0.5);
  }
}
