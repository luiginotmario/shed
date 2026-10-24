import type { Transport } from './audio';
import {
  FLAT_FINGERS,
  fingerArch,
  fretAt,
  fretWindow,
  Grader,
  HandRoles,
  lmAt,
  reaches,
  StrokeDetector,
  type Neck,
} from './coach';
import { Highway } from './highway';
import { PipOverlay } from './pip';
import { rememberSong } from './search';
import { isGuitar, loadSong, type LoadedSong } from './songsterr';
import { lowerBound, measureAt, tuningLabel } from './tab';
import type { Camera } from './vision/camera';
import type { VisionFrame } from './vision/protocol';

/** Webcam frames show the world this long after it happened. */
const CAMERA_LAG_MS = 60;
/** A gap this long before the next note offers a skip. */
const LONG_REST = 5;

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

// Per-viewer preferences. Storage can be unavailable; defaults then apply.
const PREFS_KEY = 'shed.prefs';
interface Prefs {
  speed: number;
  click: boolean;
  guide: boolean;
  camera: boolean;
  leftHanded: boolean;
  neck: Neck | null;
}
const DEFAULTS: Prefs = { speed: 70, click: true, guide: true, camera: false, leftHanded: false, neck: null };
function readPrefs(): Prefs {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}
function savePrefs(p: Prefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    /* storage unavailable */
  }
}

const PLAY_ICON = `<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.6v10.8a.6.6 0 0 0 .9.5l8.6-5.4a.6.6 0 0 0 0-1L4.9 2.1a.6.6 0 0 0-.9.5z" fill="currentColor"/></svg>`;
const PAUSE_ICON = `<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><rect x="3.5" y="2.5" width="3" height="11" rx=".8" fill="currentColor"/><rect x="9.5" y="2.5" width="3" height="11" rx=".8" fill="currentColor"/></svg>`;

const template = () => `
<div class="reveal grid h-full grid-rows-[auto_minmax(0,1fr)_auto]">
  <header class="flex h-14 items-center gap-3 border-b border-line px-3 sm:px-4">
    <button id="back" class="press flex size-9 shrink-0 items-center justify-center rounded-lg text-dim hover:bg-raise hover:text-bone" aria-label="Back to search">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M10 3L5 8l5 5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </button>
    <div class="min-w-0">
      <div id="title" class="truncate text-[14px] font-medium tracking-[-0.01em]">Loading…</div>
      <div id="artist" class="truncate text-[12px] text-dim"></div>
    </div>
    <div class="ml-auto flex items-center gap-3">
      <span id="tuning" class="hidden font-mono text-[11px] text-faint lg:block"></span>
      <select id="track" aria-label="Guitar part" class="track press h-9 max-w-[42vw] truncate rounded-lg border border-line-strong bg-raise pl-3 text-[13px] text-bone sm:max-w-[300px]"></select>
    </div>
  </header>

  <div class="grid min-h-0 grid-cols-1 grid-rows-[minmax(0,1fr)_auto] lg:grid-cols-[minmax(0,1fr)_300px] lg:grid-rows-1">
    <div class="relative min-h-[320px]">
      <canvas id="hw" class="absolute inset-0 size-full" aria-label="Tab"></canvas>
      <div id="rest" hidden class="absolute inset-x-0 bottom-6 flex items-center justify-center gap-3 text-[13px] text-dim">
        <span id="rest-text" class="tnum"></span>
        <button id="skip" class="press rounded-lg border border-line-strong px-3 py-1.5 text-bone hover:bg-raise">Skip ahead</button>
      </div>
      <div id="loading" class="absolute inset-0 grid place-items-center text-[13px] text-dim">Loading tab…</div>
    </div>

    <aside class="flex min-h-0 gap-4 border-line p-4 max-lg:items-start max-lg:border-t lg:flex-col lg:gap-5 lg:border-l">
      <section aria-label="Score" class="flex flex-1 items-end justify-between gap-3 max-lg:flex-col max-lg:items-start lg:flex-none">
        <div>
          <div class="font-mono text-[10px] tracking-[0.08em] text-faint uppercase">Timing</div>
          <div id="acc" class="mt-1 font-mono text-[40px] leading-none font-medium tracking-[-0.04em] tnum">—</div>
        </div>
        <dl class="grid grid-cols-[auto_auto] gap-x-3 gap-y-0.5 font-mono text-[11px] tnum lg:text-right">
          <dt class="text-faint">on time</dt><dd id="n-good">0</dd>
          <dt class="text-faint">early · late</dt><dd id="n-off" class="text-pilot">0 · 0</dd>
          <dt class="text-faint">missed</dt><dd id="n-miss">0</dd>
          <dt class="text-faint">streak</dt><dd id="n-streak">0</dd>
        </dl>
      </section>

      <section aria-label="Coach" aria-live="polite" class="min-h-[88px] flex-1 max-lg:hidden">
        <div class="font-mono text-[10px] tracking-[0.08em] text-faint uppercase">Coach</div>
        <div id="hint" class="relative mt-2"></div>
      </section>

      <section id="cam" class="w-[200px] shrink-0 overflow-hidden rounded-xl border border-line bg-raise sm:w-[240px] lg:w-auto">
        <div id="cam-view" class="relative aspect-[4/3] bg-black">
          <canvas id="cam-overlay" class="absolute inset-0 size-full"></canvas>
          <div id="cam-off" class="absolute inset-0 flex flex-col items-start justify-end gap-2 bg-raise-2 p-3">
            <p id="cam-msg" class="text-[12px] leading-snug text-dim">Turn on the camera to get feedback on your timing and hand position.</p>
            <button id="cam-on" class="press rounded-lg bg-bone px-3 py-1.5 text-[12px] font-medium text-ground">Turn on camera</button>
          </div>
          <div id="calib" hidden class="absolute inset-x-0 top-0 bg-ground/80 px-3 py-2 text-[12px] leading-snug backdrop-blur-sm">
            <span id="calib-text"></span>
            <button id="calib-cancel" class="ml-1 text-dim underline underline-offset-2">Cancel</button>
          </div>
        </div>
        <div class="grid gap-1.5 px-3 pt-2.5 pb-3 text-[12px]">
          <div class="flex items-center gap-2"><span id="pick-dot" class="pilot"></span><span class="text-dim">Picking</span><span id="pick-val" class="ml-auto font-mono text-[11px] text-faint">—</span></div>
          <div class="flex items-center gap-2"><span id="fret-dot" class="pilot"></span><span class="text-dim">Fretting</span><span id="fret-val" class="ml-auto font-mono text-[11px] text-faint">—</span></div>
          <div class="mt-1.5 flex gap-1.5">
            <button id="calibrate" class="press flex-1 rounded-md border border-line-strong py-1.5 text-[12px] text-dim hover:text-bone">Mark neck</button>
            <button id="lefty" aria-pressed="false" class="press flex items-center justify-center gap-1.5 rounded-md border border-line-strong px-2 py-1.5 text-[12px] text-dim hover:text-bone"><span class="pilot"></span>Lefty</button>
            <button id="cam-power" aria-label="Turn camera off" class="press rounded-md border border-line-strong px-2 text-dim hover:text-bone">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M7 1.5v5M3.8 3.5a4.5 4.5 0 1 0 6.4 0" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
            </button>
          </div>
        </div>
      </section>
    </aside>
  </div>

  <footer class="flex h-[76px] items-center gap-3 border-t border-line px-3 sm:gap-4 sm:px-4">
    <button id="play" class="press grid size-11 shrink-0 place-items-center rounded-xl bg-bone text-ground" aria-label="Play">${PLAY_ICON}</button>
    <div class="shrink-0 font-mono text-[12px] whitespace-nowrap tnum"><span id="bar">Bar 1</span><span id="bars" class="text-faint"></span></div>
    <div id="overview" class="relative h-9 min-w-0 flex-1 cursor-pointer" aria-label="Song position" role="slider" tabindex="0">
      <div class="absolute inset-x-0 top-1/2 h-[2px] -translate-y-1/2 rounded bg-line-strong"></div>
      <div id="progress" class="absolute inset-x-0 top-1/2 h-[2px] origin-left -translate-y-1/2 scale-x-0 rounded bg-bone"></div>
      <div id="markers"></div>
    </div>
    <label class="hidden items-center gap-2 md:flex">
      <span class="text-[12px] text-faint">Speed</span>
      <input id="speed" type="range" min="40" max="100" step="5" class="speed w-24" />
      <span id="speed-val" class="w-9 font-mono text-[12px] tnum"></span>
    </label>
    <button id="click" aria-pressed="true" class="press hidden h-9 items-center gap-2 rounded-lg px-2.5 text-[13px] text-dim hover:bg-raise sm:flex"><span class="pilot"></span>Click</button>
    <button id="guide" aria-pressed="true" class="press hidden h-9 items-center gap-2 rounded-lg px-2.5 text-[13px] text-dim hover:bg-raise sm:flex"><span class="pilot"></span>Guide</button>
  </footer>
</div>`;

export function mountPlayer(
  root: HTMLElement,
  opts: {
    songId: number;
    track?: number;
    transport: Transport;
    camera: Camera;
    back: () => void;
    switchTrack: (index: number) => void;
  },
) {
  const { transport, camera } = opts;
  root.innerHTML = template();
  const $ = <T extends HTMLElement = HTMLElement>(id: string) => root.querySelector<T>(`#${id}`)!;
  const prefs = readPrefs();
  let disposed = false;
  let raf = 0;

  let loaded: LoadedSong | null = null;
  let highway: Highway | null = null;
  let grader: Grader | null = null;
  const roles = new HandRoles();
  roles.leftHanded = prefs.leftHanded;
  const strokes = new StrokeDetector();
  const overlay = new PipOverlay($<HTMLCanvasElement>('cam-overlay'));

  // ───────── Camera card ─────────
  const camView = $('cam-view');
  camView.prepend(camera.video);
  camera.video.className = 'absolute inset-0 size-full -scale-x-100 object-cover';

  const setCamUI = (state: string, detail?: string) => {
    const live = state === 'live';
    $('cam-off').hidden = live;
    const msg: Record<string, string> = {
      off: 'Turn on the camera to get feedback on your timing and hand position.',
      starting: 'Starting camera…',
      loading: 'Loading hand tracking…',
      error: detail ?? 'Camera unavailable.',
    };
    $('cam-msg').textContent = msg[state] ?? '';
    $('cam-on').hidden = state === 'starting' || state === 'loading';
    if (!live) overlay.clear();
  };
  camera.onStatus = (s, d) => !disposed && setCamUI(s, d);
  setCamUI(camera.active ? 'live' : 'off');
  $('cam-on').onclick = () => {
    prefs.camera = true;
    savePrefs(prefs);
    void camera.start();
  };
  $('cam-power').onclick = () => {
    prefs.camera = false;
    savePrefs(prefs);
    camera.stop();
  };
  if (prefs.camera && !camera.active) void camera.start();

  const lefty = $('lefty');
  lefty.setAttribute('aria-pressed', String(prefs.leftHanded));
  lefty.onclick = () => {
    prefs.leftHanded = roles.leftHanded = !prefs.leftHanded;
    lefty.setAttribute('aria-pressed', String(prefs.leftHanded));
    savePrefs(prefs);
  };

  // ───────── Neck calibration: hold the index tip still on fret 3, then 12 ─────────
  const CALIB_FRETS = [3, 12];
  let calib: { step: number; holdFrom: number | null; last: { x: number; y: number } | null; points: Neck['a'][] } | null = null;
  const calibText = () => {
    if (!calib) return;
    $('calib-text').textContent = `Put your index finger on fret ${CALIB_FRETS[calib.step]} and hold still.`;
  };
  $('calibrate').onclick = () => {
    if (!camera.active) void camera.start();
    calib = { step: 0, holdFrom: null, last: null, points: [] };
    $('calib').hidden = false;
    calibText();
  };
  $('calib-cancel').onclick = () => {
    calib = null;
    $('calib').hidden = true;
  };
  const updateCalibButton = () => ($('calibrate').textContent = prefs.neck ? 'Re-mark neck' : 'Mark neck');
  updateCalibButton();

  // ───────── Vision → coach ─────────
  let lastPickSeen = 0;
  let lastFretSeen = 0;
  let lastStroke = -1e9;
  let fretEst: number | null = null;
  let flatSince: number | null = null;
  let offFretSince: number | null = null;

  camera.onResult = (frame: VisionFrame) => {
    if (disposed) return;
    const aspect = frame.w / frame.h;
    const now = performance.now();
    const r = roles.assign(frame.hands.map((h) => h.lm));

    if (r.pick) {
      lastPickSeen = now;
      const s = strokes.push(frame.ts, r.pick, aspect);
      if (s) {
        lastStroke = now;
        const t = transport.songTimeAtPerf(s.ts - CAMERA_LAG_MS);
        if (transport.playing && grader && highway && t >= transport.countInUntil) {
          const j = grader.stroke(t);
          if (j) highway.judge(j);
        }
      }
    } else strokes.reset();

    let calibProgress: number | null = null;
    if (r.fret) {
      lastFretSeen = now;
      const tip = lmAt(r.fret, 8, aspect);
      if (calib) {
        const still = calib.last && Math.hypot(tip.x - calib.last.x, tip.y - calib.last.y) < 0.012;
        calib.last = { x: tip.x, y: tip.y };
        if (!still) calib.holdFrom = null;
        else calib.holdFrom ??= now;
        calibProgress = calib.holdFrom ? Math.min(1, (now - calib.holdFrom) / 1000) : 0;
        if (calibProgress >= 1) {
          calib.points.push({ x: tip.x, y: tip.y, fret: CALIB_FRETS[calib.step] });
          calib.step++;
          calib.holdFrom = null;
          if (calib.step >= CALIB_FRETS.length) {
            prefs.neck = { a: calib.points[0], b: calib.points[1] };
            savePrefs(prefs);
            calib = null;
            $('calib').hidden = true;
            updateCalibButton();
          } else calibText();
        }
      }
      if (prefs.neck) {
        const est = fretAt(prefs.neck, r.fret, aspect);
        fretEst = fretEst == null ? est : fretEst * 0.7 + est * 0.3;
      }
      const arch = fingerArch(r.fret, aspect);
      flatSince = arch > FLAT_FINGERS ? (flatSince ?? now) : null;
    } else {
      fretEst = null;
      flatSince = null;
    }

    overlay.draw(frame, { roles: r, neck: prefs.neck, calibrating: calib ? calibProgress ?? 0 : null, sinceStroke: now - lastStroke });
  };

  // ───────── Coaching hints ─────────
  let hintText: string | null = null;
  let hintAt = 0;
  let praiseUntil = 0;
  let praiseText = '';
  let lastStreak = 0;
  const setHint = (text: string | null, quiet = false) => {
    if (text === hintText) return;
    const now = performance.now();
    // Let a hint be read before replacing it with another one.
    if (hintText && text && now - hintAt < 1800) return;
    hintText = text;
    hintAt = now;
    const slot = $('hint');
    slot.querySelectorAll('[data-hint]').forEach((el) => {
      el.setAttribute('data-leaving', '');
      el.removeAttribute('data-hint');
      setTimeout(() => el.remove(), 200);
    });
    if (!text) return;
    const el = document.createElement('p');
    el.dataset.hint = '';
    el.className = `hint absolute inset-x-0 top-0 text-[15px] leading-snug ${quiet ? 'text-dim' : 'text-bone'}`;
    el.textContent = text;
    slot.append(el);
  };

  const coach = (t: number) => {
    if (!camera.active) return setHint(null);
    const now = performance.now();
    const playing = transport.playing && t >= transport.countInUntil && !!loaded;
    if (!playing) {
      if (!prefs.neck) return setHint('Tip: mark your neck so I can check where your hand is.', true);
      return setHint(null);
    }
    if (now < praiseUntil) return setHint(praiseText);
    if (now - lastPickSeen > 1200) return setHint('Keep your picking hand in view.');
    const win = loaded && fretWindow(loaded.song, t);
    if (prefs.neck && win && fretEst != null && now - lastFretSeen < 300 && !reaches(fretEst, win)) {
      offFretSince ??= now;
      if (now - offFretSince > 500) {
        const dir = win.lo > fretEst ? 'up' : 'down';
        return setHint(`Slide ${dir} to fret ${win.lo}.`);
      }
    } else offFretSince = null;
    if (flatSince != null && now - flatSince > 1500) return setHint('Curl your fingers. Press with the tips, not the pads.');
    const drift = grader?.drift ?? 0;
    if (drift < -0.06) return setHint(`You're rushing, about ${Math.round(-drift * 1000)} ms early. Let the note reach the nut.`);
    if (drift > 0.06) return setHint(`You're dragging, about ${Math.round(drift * 1000)} ms late.`);
    setHint(null);
  };

  // ───────── Transport controls ─────────
  const playBtn = $('play');
  const syncPlay = () => {
    playBtn.innerHTML = transport.playing ? PAUSE_ICON : PLAY_ICON;
    playBtn.setAttribute('aria-label', transport.playing ? 'Pause' : 'Play');
  };
  const toggle = async () => {
    if (!loaded) return;
    if (transport.playing) transport.pause();
    else {
      // Restarting from a point regrades from there.
      grader?.reset(transport.songTime());
      highway?.clearGrades();
      await transport.play();
    }
    syncPlay();
  };
  playBtn.onclick = () => void toggle();
  transport.onEnd = syncPlay;

  const seek = (t: number) => {
    transport.seek(t);
    grader?.reset(t);
    highway?.clearGrades();
  };

  const speed = $<HTMLInputElement>('speed');
  speed.value = String(prefs.speed);
  $('speed-val').textContent = `${prefs.speed}%`;
  transport.setSpeed(prefs.speed / 100);
  speed.oninput = () => {
    prefs.speed = Number(speed.value);
    $('speed-val').textContent = `${prefs.speed}%`;
    transport.setSpeed(prefs.speed / 100);
    savePrefs(prefs);
  };

  const toggleBtn = (id: 'click' | 'guide') => {
    const b = $(id);
    const apply = () => {
      b.setAttribute('aria-pressed', String(prefs[id]));
      transport[id] = prefs[id];
    };
    apply();
    b.onclick = () => {
      prefs[id] = !prefs[id];
      apply();
      savePrefs(prefs);
    };
  };
  toggleBtn('click');
  toggleBtn('guide');

  $('back').onclick = () => opts.back();
  $('track').onchange = (e) => opts.switchTrack(Number((e.target as HTMLSelectElement).value));

  const overview = $('overview');
  overview.onclick = (e) => {
    if (!loaded) return;
    const r = overview.getBoundingClientRect();
    const t = ((e.clientX - r.left) / r.width) * loaded.song.duration;
    // Land on the start of a bar so the count-in makes sense.
    seek(loaded.song.measures[measureAt(loaded.song, t)].t);
  };

  $('skip').onclick = () => {
    if (!loaded) return;
    const next = loaded.song.hits[lowerBound(loaded.song.hits, transport.songTime())];
    if (next) seek(loaded.song.measures[Math.max(0, measureAt(loaded.song, next.t) - 1)].t);
  };

  const onKey = (e: KeyboardEvent) => {
    const tag = (e.target as HTMLElement).tagName;
    if (tag === 'SELECT' || tag === 'INPUT') return;
    if (e.key === ' ') {
      e.preventDefault();
      void toggle();
    } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && loaded) {
      e.preventDefault();
      const s = loaded.song;
      const m = measureAt(s, transport.songTime()) + (e.key === 'ArrowRight' ? 1 : -1);
      seek(s.measures[Math.max(0, Math.min(s.measures.length - 1, m))].t);
    } else if (e.key === 'Escape' && !calib) opts.back();
  };
  window.addEventListener('keydown', onKey);
  const onHide = () => {
    if (document.hidden && transport.playing) {
      transport.pause();
      syncPlay();
    }
  };
  document.addEventListener('visibilitychange', onHide);

  // ───────── Frame loop ─────────
  let lastBar = -1;
  let lastProgress = -1;
  const frame = () => {
    raf = requestAnimationFrame(frame);
    if (!loaded || !highway || !grader) return;
    const song = loaded.song;
    const t = transport.songTime();
    const inCountIn = transport.playing && t < transport.countInUntil;

    let countIn: number | null = null;
    if (inCountIn) {
      const m = song.measures[measureAt(song, transport.countInUntil)];
      const beat = m.dur / m.beats.length;
      countIn = Math.max(1, Math.ceil((transport.countInUntil - t) / beat - 1e-6));
    }
    highway.draw(t, transport.playing, countIn);

    if (transport.playing && !inCountIn && camera.active) {
      for (const j of grader.advance(t, performance.now() - lastPickSeen < 600)) highway.judge(j);
    }
    if (grader.streak !== lastStreak) {
      if ([10, 25, 50, 100].includes(grader.streak)) {
        praiseText = `${grader.streak} in a row.`;
        praiseUntil = performance.now() + 2200;
      }
      lastStreak = grader.streak;
    }
    coach(t);

    // Transport readouts, written only when they change.
    const bar = measureAt(song, Math.max(0, t));
    if (bar !== lastBar) {
      $('bar').textContent = `Bar ${bar + 1}`;
      lastBar = bar;
    }
    const p = Math.max(0, Math.min(1, t / song.duration));
    if (Math.abs(p - lastProgress) > 0.0005) {
      $('progress').style.transform = `translateY(-50%) scaleX(${p})`;
      lastProgress = p;
    }
    $('acc').textContent = grader.judged ? `${Math.round(grader.accuracy * 100)}%` : '—';
    $('n-good').textContent = String(grader.good);
    $('n-off').textContent = `${grader.early} · ${grader.late}`;
    $('n-miss').textContent = String(grader.miss);
    $('n-streak').textContent = String(grader.streak);

    const now = performance.now();
    const pickSeen = camera.active && now - lastPickSeen < 400;
    const fretSeen = camera.active && now - lastFretSeen < 400;
    $('pick-dot').dataset.on = String(pickSeen);
    $('fret-dot').dataset.on = String(fretSeen);
    $('pick-val').textContent = !camera.active ? '—' : !pickSeen ? 'not in view' : now - lastStroke < 250 ? 'stroke' : 'tracking';
    $('fret-val').textContent = !camera.active
      ? '—'
      : !fretSeen
        ? 'not in view'
        : fretEst != null
          ? `fret ~${Math.max(0, Math.round(fretEst))}`
          : 'tracking';

    // Long rests: say when the next notes come and offer to skip.
    const next = song.hits[lowerBound(song.hits, Math.max(t, 0))];
    const gap = next ? next.t - t : 0;
    const rest = $('rest');
    const showRest = !inCountIn && gap > LONG_REST;
    if (rest.hidden === showRest) rest.hidden = !showRest;
    if (showRest) {
      const s = Math.ceil(gap / (transport.speed || 1));
      $('rest-text').textContent = `Next notes in ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    }
  };

  // ───────── Load ─────────
  (async () => {
    try {
      const l = await loadSong(opts.songId, opts.track);
      if (disposed) return;
      loaded = l;
      rememberSong({ songId: l.songId, title: l.title, artist: l.artist });
      document.title = `${l.title} · Shed`;
      $('title').textContent = l.title;
      $('artist').textContent = l.artist;
      $('tuning').textContent = tuningLabel(l.song.tuning);
      const opt = (t: LoadedSong['tracks'][0]) =>
        `<option value="${t.index}" ${t.index === l.track.index ? 'selected' : ''}>${esc(t.name)}</option>`;
      const guitars = l.tracks.filter(isGuitar), others = l.tracks.filter((t) => !isGuitar(t));
      $('track').innerHTML =
        `<optgroup label="Guitar">${guitars.map(opt).join('')}</optgroup>` +
        (others.length ? `<optgroup label="Other">${others.map(opt).join('')}</optgroup>` : '');
      $('bars').textContent = ` / ${l.song.measures.length}`;
      $('markers').innerHTML = l.song.measures
        .filter((m) => m.marker)
        .map(
          (m) =>
            `<div class="absolute top-1/2 h-2.5 w-px -translate-y-1/2 bg-dim" style="left:${(m.t / l.song.duration) * 100}%" title="${esc(m.marker!)}"></div>`,
        )
        .join('');

      transport.load(l.song);
      grader = new Grader(l.song);
      highway = new Highway($<HTMLCanvasElement>('hw'), l.song);
      // Start a bar before the first note when the part comes in late.
      const first = l.song.hits[0];
      if (first && first.t > LONG_REST) seek(l.song.measures[Math.max(0, measureAt(l.song, first.t) - 1)].t);
      $('loading').remove();
      syncPlay();
      // Dev only: fake a pick stroke `dt` seconds from now to check grading without a camera.
      if (import.meta.env.DEV) {
        Object.assign(window, {
          __shedStroke: (dt = 0) => {
            const j = grader!.stroke(transport.songTime() + dt);
            if (j) highway!.judge(j);
            return j?.grade ?? null;
          },
        });
      }
    } catch (err) {
      if (disposed) return;
      $('loading').textContent = (err as Error).message || 'Could not load this tab.';
    }
  })();
  raf = requestAnimationFrame(frame);

  return () => {
    disposed = true;
    cancelAnimationFrame(raf);
    transport.stop();
    camera.onResult = undefined;
    camera.onStatus = undefined;
    window.removeEventListener('keydown', onKey);
    document.removeEventListener('visibilitychange', onHide);
  };
}
