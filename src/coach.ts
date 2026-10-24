// Everything the camera can judge. Pure logic with no DOM, so it is unit tested
// with synthetic landmarks. Coordinates are the unmirrored camera frame,
// normalized 0..1, with x scaled by the aspect ratio so distances are square.

import { lowerBound, type Hit, type Song } from './tab';

export type Vec = { x: number; y: number; z: number };
export const lmAt = (lm: Float32Array, i: number, aspect: number): Vec => ({
  x: lm[i * 3] * aspect,
  y: lm[i * 3 + 1],
  z: lm[i * 3 + 2] * aspect,
});
const dist = (a: Vec, b: Vec) => Math.hypot(a.x - b.x, a.y - b.y);

/** Wrist to middle-finger knuckle: a size unit that follows distance to camera. */
export const handSize = (lm: Float32Array, aspect: number) => dist(lmAt(lm, 0, aspect), lmAt(lm, 9, aspect));

// ───────────── Which hand is which ─────────────

export interface Roles {
  pick: Float32Array | null;
  fret: Float32Array | null;
}

/**
 * The camera faces the player, so in the unmirrored frame a right-handed
 * player's picking hand is on the left (smaller x) and the neck runs right.
 * One visible hand is matched to whichever role was last seen nearest.
 */
export class HandRoles {
  private lastPick: number | null = null;
  private lastFret: number | null = null;
  leftHanded = false;

  assign(hands: Float32Array[]): Roles {
    const flip = this.leftHanded;
    if (hands.length >= 2) {
      const [a, b] = [...hands].sort((p, q) => p[0] - q[0]);
      const pick = flip ? b : a;
      const fret = flip ? a : b;
      this.lastPick = pick[0];
      this.lastFret = fret[0];
      return { pick, fret };
    }
    if (hands.length === 1) {
      const h = hands[0], x = h[0];
      let isPick: boolean;
      if (this.lastPick != null && this.lastFret != null) {
        isPick = Math.abs(x - this.lastPick) < Math.abs(x - this.lastFret);
      } else {
        isPick = flip ? x > 0.5 : x < 0.5;
      }
      if (isPick) this.lastPick = x;
      else this.lastFret = x;
      return isPick ? { pick: h, fret: null } : { pick: null, fret: h };
    }
    return { pick: null, fret: null };
  }
}

// ───────────── Pick strokes ─────────────

export interface Stroke {
  /** performance.now() ms of the moment of fastest motion in the swing. */
  ts: number;
  dir: 'down' | 'up';
  /** Swing size in hand units. */
  amp: number;
}

/**
 * Finds pick strokes from the vertical motion of the pick grip (between the
 * thumb and index tips). A stroke is a swing between two direction reversals
 * that is big and fast enough; its time is the fastest point of the swing,
 * which is when the pick crosses the string.
 */
export class StrokeDetector {
  /** Minimum swing, in hand sizes. */
  minAmp = 0.12;
  /** Minimum peak speed, hand sizes per second. */
  minSpeed = 1.2;
  /** Reversals smaller than this (hand sizes) are treated as jitter. */
  jitter = 0.03;

  private prev: { t: number; y: number } | null = null;
  private dir = 0;
  private start = 0;
  private extreme = 0;
  private peakSpeed = 0;
  private peakT = 0;
  private size = 0;

  reset() {
    this.prev = null;
    this.dir = 0;
  }

  /** Feed one frame; returns a stroke when a swing completes. */
  push(ts: number, lm: Float32Array, aspect: number): Stroke | null {
    const size = handSize(lm, aspect);
    this.size = this.size ? this.size * 0.8 + size * 0.2 : size;
    const s = this.size || 0.1;
    const y = (lm[4 * 3 + 1] + lm[8 * 3 + 1]) / 2 / s;
    const prev = this.prev;
    this.prev = { t: ts, y };
    if (!prev) {
      this.start = this.extreme = y;
      return null;
    }
    const dt = (ts - prev.t) / 1000;
    if (dt <= 0 || dt > 0.25) {
      // Gap in tracking: start over rather than join two unrelated swings.
      this.dir = 0;
      this.start = this.extreme = y;
      return null;
    }
    const v = (y - prev.y) / dt;
    const moving = Math.sign(y - this.extreme);

    if (this.dir === 0) {
      if (Math.abs(y - this.start) > this.jitter) {
        this.dir = Math.sign(y - this.start);
        this.extreme = y;
        this.peakSpeed = Math.abs(v);
        this.peakT = (ts + prev.t) / 2;
      }
      return null;
    }

    if (moving === this.dir || moving === 0) {
      if ((y - this.extreme) * this.dir > 0) this.extreme = y;
      if (Math.abs(v) > this.peakSpeed && Math.sign(v) === this.dir) {
        this.peakSpeed = Math.abs(v);
        this.peakT = (ts + prev.t) / 2;
      }
      return null;
    }

    // Moving against the swing. Ignore jitter until the reversal is real.
    if (Math.abs(y - this.extreme) < this.jitter) return null;

    const amp = Math.abs(this.extreme - this.start);
    const stroke: Stroke | null =
      amp >= this.minAmp && this.peakSpeed >= this.minSpeed
        ? { ts: this.peakT, dir: this.dir > 0 ? 'down' : 'up', amp }
        : null;
    // The reversal starts the next swing from the extreme.
    this.start = this.extreme;
    this.dir = -this.dir;
    this.extreme = y;
    this.peakSpeed = Math.sign(v) === this.dir ? Math.abs(v) : 0;
    this.peakT = (ts + prev.t) / 2;
    return stroke;
  }
}

// ───────────── Timing grades ─────────────

export type Grade = 'good' | 'early' | 'late' | 'miss';

export interface Judgement {
  hit: Hit;
  grade: Grade;
  /** Seconds, negative = early. */
  offset: number;
}

export const GOOD_WINDOW = 0.09;
export const HIT_WINDOW = 0.28;
/** How long after a note we wait before calling it missed (strokes are reported at the reversal). */
const MISS_AFTER = 0.45;

export class Grader {
  readonly grades = new Map<Hit, Judgement>();
  good = 0;
  early = 0;
  late = 0;
  miss = 0;
  streak = 0;
  best = 0;
  private offsets: number[] = [];
  private checkedTo = 0;

  constructor(private song: Song) {}

  reset(from = 0) {
    this.grades.clear();
    this.good = this.early = this.late = this.miss = this.streak = 0;
    this.offsets = [];
    this.checkedTo = from;
  }

  get judged() {
    return this.good + this.early + this.late + this.miss;
  }

  /** 0..1, early and late count half. */
  get accuracy() {
    const n = this.judged;
    return n ? (this.good + 0.5 * (this.early + this.late)) / n : 0;
  }

  /** Mean timing offset over the last few strokes, in seconds. */
  get drift() {
    const recent = this.offsets.slice(-8);
    return recent.length >= 4 ? recent.reduce((a, b) => a + b, 0) / recent.length : 0;
  }

  /** A stroke at song time t. Returns the judgement it produced, if any. */
  stroke(t: number): Judgement | null {
    const hits = this.song.hits;
    let best: Hit | null = null;
    for (let i = Math.max(0, lowerBound(hits, t - HIT_WINDOW)); i < hits.length && hits[i].t <= t + HIT_WINDOW; i++) {
      const h = hits[i];
      if (this.grades.has(h)) continue;
      if (!best || Math.abs(h.t - t) < Math.abs(best.t - t)) best = h;
    }
    if (!best) return null;
    const offset = t - best.t;
    const grade: Grade = Math.abs(offset) <= GOOD_WINDOW ? 'good' : offset < 0 ? 'early' : 'late';
    return this.record({ hit: best, grade, offset });
  }

  /**
   * Marks notes nobody struck as missed. `watching` is false while the
   * picking hand is out of view; those notes are skipped, not failed.
   */
  advance(t: number, watching: boolean): Judgement[] {
    const out: Judgement[] = [];
    const hits = this.song.hits;
    const until = t - MISS_AFTER;
    for (let i = lowerBound(hits, this.checkedTo); i < hits.length && hits[i].t < until; i++) {
      const h = hits[i];
      if (this.grades.has(h)) continue;
      if (watching) out.push(this.record({ hit: h, grade: 'miss', offset: 0 }));
    }
    this.checkedTo = Math.max(this.checkedTo, until);
    return out;
  }

  private record(j: Judgement) {
    this.grades.set(j.hit, j);
    this[j.grade]++;
    if (j.grade === 'miss') this.streak = 0;
    else {
      this.offsets.push(j.offset);
      this.streak = j.grade === 'good' ? this.streak + 1 : 0;
      this.best = Math.max(this.best, this.streak);
    }
    return j;
  }
}

// ───────────── Fretting hand form ─────────────

/** Angle at b in degrees, 3D. */
function angle(a: Vec, b: Vec, c: Vec) {
  const u = { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
  const v = { x: c.x - b.x, y: c.y - b.y, z: c.z - b.z };
  const d = Math.hypot(u.x, u.y, u.z) * Math.hypot(v.x, v.y, v.z);
  if (!d) return 180;
  const cos = (u.x * v.x + u.y * v.y + u.z * v.z) / d;
  return (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
}

/** Mean middle-joint angle of index, middle and ring: ~180° is flat, lower is arched. */
export function fingerArch(lm: Float32Array, aspect: number): number {
  const p = (i: number) => lmAt(lm, i, aspect);
  const joints = [
    [5, 6, 7],
    [9, 10, 11],
    [13, 14, 15],
  ];
  return joints.reduce((s, [a, b, c]) => s + angle(p(a), p(b), p(c)), 0) / joints.length;
}

/** Fingers this straight while fretting means playing on the pads. */
export const FLAT_FINGERS = 158;

// ───────────── Where the hand is on the neck ─────────────

export interface NeckPoint {
  x: number;
  y: number;
  fret: number;
}

export interface Neck {
  a: NeckPoint;
  b: NeckPoint;
}

/** Distance from the nut to fret n, as a fraction of scale length. */
const fretPos = (n: number) => 1 - 2 ** (-n / 12);

/**
 * Estimates the fret under the index fingertip by projecting it on the line
 * through two calibrated fret positions and inverting the fret spacing rule.
 */
export function fretAt(neck: Neck, lm: Float32Array, aspect: number): number {
  const tip = lmAt(lm, 8, aspect);
  const dx = neck.b.x - neck.a.x, dy = neck.b.y - neck.a.y;
  const len2 = dx * dx + dy * dy;
  if (!len2) return neck.a.fret;
  const u = ((tip.x - neck.a.x) * dx + (tip.y - neck.a.y) * dy) / len2;
  const pa = fretPos(neck.a.fret), pb = fretPos(neck.b.fret);
  const p = Math.min(0.97, pa + u * (pb - pa));
  return p <= 0 ? 0 : -12 * Math.log2(1 - p);
}

/** Point on the neck line for a given fret, for drawing. */
export function neckPoint(neck: Neck, fret: number) {
  const pa = fretPos(neck.a.fret), pb = fretPos(neck.b.fret);
  const u = (fretPos(fret) - pa) / (pb - pa);
  return { x: neck.a.x + u * (neck.b.x - neck.a.x), y: neck.a.y + u * (neck.b.y - neck.a.y) };
}

/**
 * The frets needed soon, ignoring open strings. A hand covers about four
 * frets with the index on the lowest one.
 */
export function fretWindow(song: Song, t: number, ahead = 0.6): { lo: number; hi: number } | null {
  let lo = Infinity, hi = -Infinity;
  for (let i = lowerBound(song.notes, t - 0.1); i < song.notes.length && song.notes[i].t < t + ahead; i++) {
    const f = song.notes[i].fret;
    if (f <= 0 || song.notes[i].dead) continue;
    lo = Math.min(lo, f);
    hi = Math.max(hi, f);
  }
  return lo === Infinity ? null : { lo, hi };
}

/** True when the hand at `est` can reach the window without shifting. */
export const reaches = (est: number, w: { lo: number; hi: number }) => w.lo >= est - 1.5 && w.hi <= est + 4.5;
