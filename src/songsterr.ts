import { parseTrack, tuningAdvice, type RawTrack, type Song } from './tab';

// Search and metadata go through the same-origin /songsterr proxy (see
// vite.config.ts and vercel.json). Tab JSON comes from their CDN directly.
const CDN = 'https://dqsljvtekg760.cloudfront.net';

export interface TrackInfo {
  index: number;
  name: string;
  instrument: string;
  instrumentId: number;
  tuning?: number[];
  difficulty?: number;
  views: number;
}

export interface SongInfo {
  songId: number;
  title: string;
  artist: string;
  tracks: TrackInfo[];
  /** Index into `tracks` of the most played guitar part. */
  guitarTrack: number;
}

export interface LoadedSong extends SongInfo {
  track: TrackInfo;
  song: Song;
}

interface RawSongTrack {
  instrumentId: number;
  instrument: string;
  name?: string;
  tuning?: number[];
  difficulty?: number;
  views?: number;
  isVocalTrack?: boolean;
  isEmpty?: boolean;
}

interface RawSong {
  songId: number;
  title: string;
  artist: string;
  tracks: RawSongTrack[];
  popularTrackGuitar?: number;
  popularTrack?: number;
  defaultTrack?: number;
}

// General MIDI programs 24–31 are guitars, 32–39 basses; 1024 is Songsterr's drum kit.
export const isGuitar = (t: { instrumentId: number }) => t.instrumentId >= 24 && t.instrumentId <= 31;
const playable = (t: RawSongTrack) =>
  t.instrumentId !== 1024 && !t.isVocalTrack && !t.isEmpty && (t.tuning?.length ?? 0) >= 4;

const ROLE = /lead|rhythm|solo|riff|guitar|bass|acoustic|clean|chords?|melody|intro|fill/i;

/**
 * Tab authors pack player, gear and role into one name ("Jack White | Kay
 * Archtop | Lead Guitar"). Keep the part that says what the track plays.
 */
export function partName(name: string | undefined, instrument: string): string {
  const parts = (name ?? '')
    .split(/\s+[|/–-]\s+|\s*\|\s*/)
    .map((p) => p.replace(/^["'(]+|["')]+$/g, '').trim())
    .filter(Boolean);
  const role = parts.find((p) => ROLE.test(p));
  return role ?? parts[parts.length - 1] ?? instrument;
}

/** Tracks a normally tuned guitar can play without turning a peg. */
const noRetune = (t: TrackInfo) => !!t.tuning && !tuningAdvice(t.tuning).retune;

function toInfo(s: RawSong): SongInfo {
  const tracks = s.tracks
    .map((t, index) => ({ t, index }))
    .filter(({ t }) => playable(t))
    .map(({ t, index }) => ({
      index,
      name: partName(t.name, t.instrument),
      instrument: t.instrument,
      instrumentId: t.instrumentId,
      tuning: t.tuning,
      difficulty: t.difficulty,
      views: t.views ?? 0,
    }));
  // Same names ("Lead Guitar" twice) get numbered so the menu is unambiguous.
  const seen = new Map<string, number>();
  for (const t of tracks) seen.set(t.name, (seen.get(t.name) ?? 0) + 1);
  const count = new Map<string, number>();
  for (const t of tracks) {
    if (seen.get(t.name)! < 2) continue;
    count.set(t.name, (count.get(t.name) ?? 0) + 1);
    t.name = `${t.name} ${count.get(t.name)}`;
  }

  // Default to the most played guitar part that needs no retuning.
  const guitars = tracks.filter(isGuitar);
  const preferred = s.popularTrackGuitar ?? s.popularTrack ?? s.defaultTrack;
  const popular = guitars.find((t) => t.index === preferred);
  const easy = [...guitars].filter(noRetune).sort((a, b) => b.views - a.views)[0];
  const guitarTrack =
    (popular && noRetune(popular) ? popular : easy ?? popular ?? guitars[0] ?? tracks[0])?.index ?? 0;
  return { songId: s.songId, title: s.title, artist: s.artist, tracks, guitarTrack };
}

async function json<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return res.json() as Promise<T>;
}

export async function searchSongs(query: string, signal?: AbortSignal): Promise<SongInfo[]> {
  const q = query.trim();
  if (!q) return [];
  const raw = await json<RawSong[]>(`/songsterr/songs?size=20&pattern=${encodeURIComponent(q)}`, signal);
  return raw.map(toInfo).filter((s) => s.tracks.some(isGuitar));
}

export async function loadSong(songId: number, trackIndex?: number): Promise<LoadedSong> {
  const meta = await json<RawSong & { revisionId: number; image: string }>(`/songsterr/meta/${songId}`);
  const info = toInfo(meta);
  const track = info.tracks.find((t) => t.index === trackIndex) ?? info.tracks.find((t) => t.index === info.guitarTrack);
  if (!track) throw new Error('This song has no guitar part.');
  const raw = await json<RawTrack>(`${CDN}/${songId}/${meta.revisionId}/${meta.image}/${track.index}.json`);
  return { ...info, track, song: parseTrack(raw) };
}
