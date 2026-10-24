import { describe, expect, it } from 'vitest';
import { measureAt, parseTrack, tuningAdvice, type RawTrack } from '../src/tab';

const bar = (beats: RawTrack['measures'][0]['voices'][0]['beats'], extra = {}) => ({ voices: [{ beats }], ...extra });
const q = (string: number, fret: number, more = {}) => ({ notes: [{ string, fret, ...more }], duration: [1, 4] as [number, number] });

describe('parseTrack', () => {
  it('places notes on a 120 bpm grid', () => {
    const song = parseTrack({
      measures: [bar([q(4, 7), q(4, 7), q(4, 10), q(4, 5)]), bar([q(3, 2), q(3, 0), q(3, 2), q(3, 0)])],
      automations: { tempo: [{ measure: 0, bpm: 120 }] },
    });
    expect(song.notes.map((n) => n.t)).toEqual([0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5]);
    expect(song.duration).toBe(4);
    expect(song.measures[1].beats).toEqual([2, 2.5, 3, 3.5]);
    expect(song.notes[0].midi).toBe(45 + 7);
    expect(measureAt(song, 2.1)).toBe(1);
  });

  it('extends ties instead of adding notes', () => {
    const song = parseTrack({
      measures: [bar([q(0, 3), q(0, 3, { tie: true }), { notes: [{ rest: true }], rest: true, duration: [1, 2] }])],
      automations: { tempo: [{ measure: 0, bpm: 60 }] },
    });
    expect(song.notes).toHaveLength(1);
    expect(song.notes[0].dur).toBe(2);
    expect(song.hits).toHaveLength(1);
  });

  it('does not ask for a pick stroke on hammer-ons', () => {
    const song = parseTrack({
      measures: [bar([q(2, 5, { hp: true }), q(2, 7), q(2, 5), q(2, 7)])],
    });
    expect(song.notes[1].legato).toBe(true);
    expect(song.hits.map((h) => h.notes[0].fret)).toEqual([5, 5, 7]);
  });

  it('groups chord notes and voices into one stroke', () => {
    const song = parseTrack({
      measures: [
        {
          voices: [
            { beats: [{ notes: [{ string: 5, fret: 3 }, { string: 4, fret: 5 }], duration: [1, 1] }] },
            { beats: [{ notes: [{ string: 0, fret: 3 }], duration: [1, 1] }] },
          ],
        },
      ],
    });
    expect(song.hits).toHaveLength(1);
    expect(song.hits[0].notes).toHaveLength(3);
  });

  it('reads tuplets either way and ignores grace notes for timing', () => {
    const triplet = (f: number) => ({ notes: [{ string: 1, fret: f }], duration: [1, 8] as [number, number], tuplet: 3 });
    const song = parseTrack({
      measures: [
        bar([
          { notes: [{ string: 1, fret: 9 }], duration: [1, 64], graceNote: 'beforeBeat' },
          triplet(1), triplet(2), triplet(3), triplet(4), triplet(5), triplet(6),
          { notes: [{ string: 1, fret: 7 }], duration: [1, 2] },
        ]),
      ],
      automations: { tempo: [{ measure: 0, bpm: 60 }] },
    });
    const t = song.notes.map((n) => +n.t.toFixed(3));
    expect(t).toEqual([0, 0.333, 0.667, 1, 1.333, 1.667, 2]);
  });

  it('follows tempo and meter changes', () => {
    const song = parseTrack({
      measures: [bar([q(0, 0), q(0, 0), q(0, 0), q(0, 0)]), bar([q(0, 0), q(0, 0)], { signature: [6, 8] })],
      automations: { tempo: [{ measure: 0, bpm: 120 }, { measure: 1, bpm: 60 }] },
    });
    expect(song.measures[1].t).toBe(2);
    expect(song.measures[1].dur).toBe(3);
    expect(song.measures[1].beats).toEqual([2, 3.5]);
  });
});

describe('tuningAdvice', () => {
  it('only asks to retune when frets would land on wrong notes', () => {
    expect(tuningAdvice([64, 59, 55, 50, 45, 40])).toMatchObject({ label: 'Standard tuning', retune: false });
    // Tuned down evenly or an octave down: same frets on a standard guitar.
    expect(tuningAdvice([62, 57, 53, 48, 43, 38]).retune).toBe(false);
    expect(tuningAdvice([50, 45, 41, 36, 31, 26]).play).toEqual([64, 59, 55, 50, 45, 40]);
    expect(tuningAdvice([64, 59, 55, 50, 45, 38])).toMatchObject({ label: 'Drop D', retune: true });
    expect(tuningAdvice([62, 57, 53, 48, 43, 36])).toMatchObject({ label: 'Drop D', play: [64, 59, 55, 50, 45, 38] });
    expect(tuningAdvice([64, 61, 57, 52, 45, 40])).toMatchObject({ label: 'Special tuning', retune: true });
  });
});

import { partName } from '../src/songsterr';
describe('partName', () => {
  it('keeps the role and drops player and gear', () => {
    expect(partName('Jack White | Kay Archtop Hollow-Body | Lead Guitar', 'Overdriven Guitar')).toBe('Lead Guitar');
    expect(partName('Kevin Parker - Lead Guitar - Squier J Mascis', 'x')).toBe('Lead Guitar');
    expect(partName('Jack White | Kay Archtop Hollow-Body | "Bass"', 'x')).toBe('Bass');
    expect(partName('', 'Distortion Guitar')).toBe('Distortion Guitar');
  });
});
