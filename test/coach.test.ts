import { describe, expect, it } from 'vitest';
import { FLAT_FINGERS, fingerArch, fretAt, Grader, HandRoles, neckPoint, StrokeDetector } from '../src/coach';
import { parseTrack } from '../src/tab';

/** A flat hand at (x, y) with the given size; fingers straight up. */
function hand(x: number, y: number, size = 0.15, curl = 0): Float32Array {
  const lm = new Float32Array(63);
  const set = (i: number, px: number, py: number, pz = 0) => {
    lm[i * 3] = px;
    lm[i * 3 + 1] = py;
    lm[i * 3 + 2] = pz;
  };
  set(0, x, y);
  for (let f = 0; f < 5; f++) {
    const fx = x + (f - 2) * size * 0.25;
    for (let j = 1; j <= 4; j++) {
      const i = f * 4 + j;
      // Curl bends the outer two joints toward the camera.
      const bend = j >= 3 ? curl * (j - 2) * size * 0.25 : 0;
      set(i, fx, y - size * (0.4 + 0.3 * Math.min(j, 2)) - (j > 2 ? size * 0.25 * (j - 2) * (1 - curl) : 0), -bend);
    }
  }
  // Make wrist → middle knuckle exactly `size`.
  set(9, x, y - size);
  return lm;
}

describe('HandRoles', () => {
  it('puts the picking hand on the image left for right-handers', () => {
    const r = new HandRoles();
    const left = hand(0.3, 0.6), right = hand(0.7, 0.5);
    expect(r.assign([right, left])).toEqual({ pick: left, fret: right });
    r.leftHanded = true;
    expect(r.assign([right, left])).toEqual({ pick: right, fret: left });
  });

  it('keeps a lone hand in the role it was last seen in', () => {
    const r = new HandRoles();
    r.assign([hand(0.3, 0.6), hand(0.7, 0.5)]);
    expect(r.assign([hand(0.68, 0.5)]).fret).not.toBeNull();
    expect(r.assign([hand(0.33, 0.5)]).pick).not.toBeNull();
  });
});

describe('StrokeDetector', () => {
  const run = (ys: number[], fps = 30) => {
    const d = new StrokeDetector();
    const out = [];
    for (let i = 0; i < ys.length; i++) {
      const s = d.push((i * 1000) / fps, hand(0.3, ys[i], 0.15), 1);
      if (s) out.push(s);
    }
    return out;
  };

  it('finds each swing of a steady strum at its fastest point', () => {
    // 2 Hz strum: down and up each 250 ms, amplitude 0.06 (0.4 hand sizes).
    const ys = Array.from({ length: 60 }, (_, i) => 0.6 + 0.03 * Math.cos((2 * Math.PI * 2 * i) / 30));
    const strokes = run(ys);
    expect(strokes.length).toBeGreaterThanOrEqual(6);
    // Fastest points of a cosine are at quarter periods: 125 ms, 375 ms, ...
    for (const s of strokes) {
      const phase = ((s.ts - 125) / 250) % 1;
      expect(Math.min(phase, 1 - phase)).toBeLessThan(0.2);
    }
    expect(strokes.map((s) => s.dir).slice(0, 2)).toEqual(['up', 'down']);
  });

  it('ignores a hand that is only trembling', () => {
    const ys = Array.from({ length: 60 }, (_, i) => 0.6 + 0.002 * Math.sin(i * 1.7));
    expect(run(ys)).toHaveLength(0);
  });
});

describe('Grader', () => {
  const song = parseTrack({
    measures: [{ voices: [{ beats: [0, 1, 2, 3].map(() => ({ notes: [{ string: 4, fret: 7 }], duration: [1, 4] as [number, number] })) }] }],
    automations: { tempo: [{ measure: 0, bpm: 60 }] },
  });

  it('grades strokes against the nearest open note', () => {
    const g = new Grader(song);
    expect(g.stroke(0.03)?.grade).toBe('good');
    expect(g.stroke(0.8)?.grade).toBe('early');
    expect(g.stroke(2.2)?.grade).toBe('late');
    expect(g.stroke(2.25)).toBeNull();
    expect(g.advance(4, true).map((j) => j.grade)).toEqual(['miss']);
    expect(g.accuracy).toBeCloseTo((1 + 0.5 * 2) / 4);
  });

  it('does not fail notes while the hand is out of view', () => {
    const g = new Grader(song);
    expect(g.advance(4, false)).toHaveLength(0);
    expect(g.miss).toBe(0);
  });
});

describe('fretting hand', () => {
  it('tells flat fingers from arched ones', () => {
    expect(fingerArch(hand(0.5, 0.5), 1)).toBeGreaterThan(FLAT_FINGERS);
    expect(fingerArch(hand(0.5, 0.5, 0.15, 1), 1)).toBeLessThan(FLAT_FINGERS);
  });

  it('maps the index tip to a fret using the calibrated neck', () => {
    const neck = { a: { x: 0.9, y: 0.4, fret: 1 }, b: { x: 0.5, y: 0.45, fret: 12 } };
    for (const f of [1, 3, 5, 7, 12]) {
      const p = neckPoint(neck, f);
      const lm = hand(0, 0);
      lm[8 * 3] = p.x;
      lm[8 * 3 + 1] = p.y;
      expect(fretAt(neck, lm, 1)).toBeCloseTo(f, 5);
    }
  });
});
