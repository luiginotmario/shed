// Turns a Songsterr track (measures → voices → beats → notes, durations as
// fractions of a whole note) into absolute-time notes, pick targets and
// measures the player, the synth and the coach can all share.

export interface RawNote {
  fret?: number;
  string?: number;
  rest?: boolean;
  tie?: boolean;
  dead?: boolean;
  ghost?: boolean;
  hp?: boolean;
  slide?: string;
}

export interface RawBeat {
  notes?: RawNote[];
  duration: [number, number];
  rest?: boolean;
  tuplet?: number;
  graceNote?: string;
  palmMute?: boolean;
}

export interface RawMeasure {
  voices: { beats: RawBeat[] }[];
  signature?: [number, number];
  marker?: { text: string };
}

export interface RawTrack {
  name?: string;
  instrument?: string;
  tuning?: number[];
  strings?: number;
  measures: RawMeasure[];
  automations?: { tempo?: { measure: number; position?: number; bpm: number; type?: number }[] };
}

export interface Note {
  /** Seconds from song start (at 100% speed). */
  t: number;
  /** How long it rings, ties included. */
  dur: number;
  /** 0 = highest string, as in a tab. */
  string: number;
  fret: number;
  midi: number;
  dead: boolean;
  /** Sounded by a hammer-on, pull-off or legato slide, so not picked. */
  legato: boolean;
  palmMute: boolean;
}

/** A moment the picking hand should strike: one or more notes at once. */
export interface Hit {
  t: number;
  notes: Note[];
  measure: number;
}

export interface Measure {
  index: number;
  t: number;
  dur: number;
  bpm: number;
  sig: [number, number];
  /** Beat times for the metronome, first one is the downbeat. */
  beats: number[];
  marker?: string;
}

export interface Song {
  tuning: number[];
  notes: Note[];
  hits: Hit[];
  measures: Measure[];
  duration: number;
}

const EPS = 1e-6;

/** Tuplet n fits n notes in the space of the next lower power of two. */
const tupletFactor = (n: number) => {
  let p = 1;
  while (p * 2 < n) p *= 2;
  return p / n;
};

const beatLength = (b: RawBeat, withTuplets: boolean) => {
  if (b.graceNote) return 0;
  const raw = b.duration[0] / b.duration[1];
  return withTuplets && b.tuplet ? raw * tupletFactor(b.tuplet) : raw;
};

/**
 * Songsterr usually stores tuplet beats with their written value. Some tabs
 * store them already scaled. Pick whichever reading fills the bar.
 */
function voiceLengths(beats: RawBeat[], barLength: number): number[] {
  const plain = beats.map((b) => beatLength(b, false));
  if (!beats.some((b) => b.tuplet)) return plain;
  const scaled = beats.map((b) => beatLength(b, true));
  const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
  return Math.abs(sum(scaled) - barLength) < Math.abs(sum(plain) - barLength) ? scaled : plain;
}

export function parseTrack(track: RawTrack): Song {
  const tuning = track.tuning?.length ? track.tuning : [64, 59, 55, 50, 45, 40];
  const tempos = [...(track.automations?.tempo ?? [])].sort((a, b) => a.measure - b.measure);
  let bpm = tempos[0]?.bpm ?? 120;
  let sig: [number, number] = [4, 4];
  let t = 0;

  const measures: Measure[] = [];
  const notes: Note[] = [];
  // Last attacked note per string, so ties extend it and legato marks carry over.
  const lastOnString = new Map<number, { note: Note; legatoNext: boolean }>();

  track.measures.forEach((m, index) => {
    for (const tp of tempos) if (tp.measure === index) bpm = tp.bpm;
    if (m.signature) sig = m.signature;
    // Tempo is in quarter notes per minute; durations are in whole notes.
    const whole = (4 * 60) / bpm;
    const barLength = sig[0] / sig[1];
    const dur = barLength * whole;

    // Compound meters (6/8, 9/8, 12/8) click on dotted quarters.
    const unit = sig[1] === 8 && sig[0] % 3 === 0 ? 3 / 8 : 1 / sig[1];
    const beats: number[] = [];
    for (let p = 0; p < barLength - EPS; p += unit) beats.push(t + p * whole);

    for (const voice of m.voices) {
      const lengths = voiceLengths(voice.beats, barLength);
      const total = lengths.reduce((a, b) => a + b, 0);
      // Overfull bars (bad tabs) are squeezed so later bars stay in time.
      const squeeze = total > barLength + EPS ? barLength / total : 1;
      let pos = 0;
      voice.beats.forEach((b, i) => {
        const len = lengths[i] * squeeze;
        if (!b.rest && !b.graceNote) {
          for (const n of b.notes ?? []) {
            if (n.rest || n.fret == null || n.string == null) continue;
            const prev = lastOnString.get(n.string);
            if (n.tie && prev) {
              prev.note.dur += len * whole;
              continue;
            }
            const note: Note = {
              t: t + pos * whole,
              dur: len * whole,
              string: n.string,
              fret: n.fret,
              midi: (tuning[n.string] ?? 40) + n.fret,
              dead: !!n.dead,
              legato: !!prev?.legatoNext && prev.note.t + prev.note.dur >= t + pos * whole - 0.01,
              palmMute: !!b.palmMute,
            };
            notes.push(note);
            lastOnString.set(n.string, { note, legatoNext: !!n.hp || n.slide === 'legato' });
          }
        }
        pos += len;
      });
    }

    measures.push({ index, t, dur, bpm, sig, beats, marker: m.marker?.text || undefined });
    t += dur;
  });

  notes.sort((a, b) => a.t - b.t || a.string - b.string);

  // Notes that start within 15 ms of each other are one stroke (chords, voices).
  const hits: Hit[] = [];
  let mi = 0;
  for (const n of notes) {
    if (n.legato) continue;
    const last = hits[hits.length - 1];
    if (last && n.t - last.t < 0.015) {
      last.notes.push(n);
      continue;
    }
    while (mi + 1 < measures.length && measures[mi + 1].t <= n.t + EPS) mi++;
    hits.push({ t: n.t, notes: [n], measure: mi });
  }

  return { tuning, notes, hits, measures, duration: t };
}

const NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
export const noteName = (midi: number) => NAMES[((midi % 12) + 12) % 12];

export const STANDARD = [64, 59, 55, 50, 45, 40];

export interface TuningAdvice {
  /** Short name, e.g. "Standard tuning". */
  label: string;
  /** What a beginner with a normally tuned guitar should do, in plain words. */
  detail: string;
  /** True when the player has to turn a peg before playing. */
  retune: boolean;
  /** Open-string pitches of the player's guitar after following the advice. */
  play: number[];
}

const halfSteps = (n: number) => (n === 1 ? 'a half step' : n === 2 ? 'a whole step' : `${n} half steps`);

/**
 * Turns a tuning into advice for someone holding a normally tuned guitar.
 * A tab tuned down evenly (or an octave down) is played with the same frets
 * in standard tuning; only drop and special tunings need a peg turned.
 */
export function tuningAdvice(tuning: number[]): TuningAdvice {
  if (tuning.length !== 6) {
    return {
      label: `${tuning.length}-string tuning`,
      detail: `This part is written for a ${tuning.length}-string instrument, so some notes won't fit on a normal guitar.`,
      retune: true,
      play: tuning,
    };
  }
  const diff = tuning.map((m, i) => m - STANDARD[i]);
  const upper = diff.slice(0, 5);
  const even = upper.every((d) => d === upper[0]);
  const drop = even ? diff[5] - upper[0] : NaN;
  // How far below standard the record sounds, ignoring whole octaves.
  const down = even ? ((-upper[0] % 12) + 12) % 12 : 0;
  const lower = down
    ? ` The record is tuned ${halfSteps(down)} lower, so yours will sound a little higher. That's fine.`
    : '';

  if (even && drop === 0) {
    return {
      label: down ? 'Standard tuning (record is lower)' : 'Standard tuning',
      detail: `Your guitar's normal tuning. Nothing to change.${lower}`,
      retune: false,
      play: STANDARD,
    };
  }
  if (even && drop === -2) {
    return {
      label: 'Drop D',
      detail: `Tune your thickest string (6) down to D: turn its peg slowly until it sounds like string 4, only lower.${lower}`,
      retune: true,
      play: [...STANDARD.slice(0, 5), 38],
    };
  }
  const names = [...tuning].reverse().map(noteName).join(' ');
  return {
    label: 'Special tuning',
    detail: `Tune your strings, thickest to thinnest, to ${names}. A tuner app makes this easy.`,
    retune: true,
    play: tuning,
  };
}

/** Plays the song on the player's guitar: same frets, their tuning. */
export function retune(song: Song, play: number[]) {
  song.tuning = play;
  for (const n of song.notes) n.midi = (play[n.string] ?? 40) + n.fret;
}

/** Index of the measure playing at time t. */
export function measureAt(song: Song, t: number): number {
  let lo = 0, hi = song.measures.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (song.measures[mid].t <= t + EPS) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** First index in a time-sorted array with item.t >= t. */
export function lowerBound<T extends { t: number }>(arr: T[], t: number): number {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].t < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
