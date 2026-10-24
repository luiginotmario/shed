import { isGuitar, searchSongs, type SongInfo } from './songsterr';
import { tuningAdvice } from './tab';

const SUGGESTIONS = ['Seven Nation Army', 'Smoke on the Water', 'Come As You Are', 'Let It Happen', 'Wonderwall', 'Back in Black'];

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

const RECENT_KEY = 'shed.recent';
type Recent = { songId: number; title: string; artist: string };
function readRecent(): Recent[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
  } catch {
    return [];
  }
}
export function rememberSong(r: Recent) {
  try {
    const list = [r, ...readRecent().filter((x) => x.songId !== r.songId)].slice(0, 5);
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    /* storage unavailable */
  }
}

/** Difficulty 1–5 as three small fret bars. */
function difficulty(d?: number) {
  if (!d) return '';
  const lit = Math.max(1, Math.min(3, Math.round((d / 5) * 3)));
  return `<span class="flex items-end gap-[2px]" aria-label="Difficulty ${d} of 5">${[0, 1, 2]
    .map((i) => `<span class="w-[3px] rounded-[1px] ${i < lit ? 'bg-dim' : 'bg-line-strong'}" style="height:${6 + i * 3}px"></span>`)
    .join('')}</span>`;
}

export function mountSearch(root: HTMLElement, open: (songId: number) => void, initialQuery = '') {
  root.innerHTML = `
    <main class="min-h-full px-4 sm:px-6">
      <header class="mx-auto flex h-16 max-w-[720px] items-center gap-2.5">
        <img src="/favicon.svg" alt="" class="size-5 rounded-[4px]" />
        <span class="text-[15px] font-semibold tracking-[-0.01em]">Shed</span>
      </header>
      <section class="reveal mx-auto max-w-[720px] pt-[12vh] pb-24">
        <h1 class="text-[40px] leading-[1.05] font-semibold tracking-[-0.03em] sm:text-[52px]">Pick a song.</h1>
        <p class="mt-3 max-w-[520px] text-[15px] leading-relaxed text-dim">
          Search anything with a guitar part. Play along with the tab while the camera
          watches your hands and tells you when you rush, drag, or slip off the fret.
        </p>
        <label class="mt-9 flex h-14 items-center gap-3 rounded-xl border border-line-strong bg-raise px-4 focus-within:border-dim">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" class="shrink-0 text-faint" aria-hidden="true"><circle cx="7" cy="7" r="5.25" stroke="currentColor" stroke-width="1.5"/><path d="M11 11l3.5 3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
          <input id="q" type="search" autocomplete="off" spellcheck="false" placeholder="Song or artist"
            class="h-full flex-1 bg-transparent text-[17px] outline-none placeholder:text-faint" />
          <kbd class="hidden rounded border border-line-strong px-1.5 font-mono text-[11px] text-faint sm:block">/</kbd>
        </label>
        <div id="status" class="mt-4 min-h-5 text-[13px] text-faint"></div>
        <ol id="results" class="mt-1" role="listbox" aria-label="Songs"></ol>
      </section>
    </main>`;

  const input = root.querySelector<HTMLInputElement>('#q')!;
  const list = root.querySelector<HTMLOListElement>('#results')!;
  const status = root.querySelector<HTMLDivElement>('#status')!;
  let results: SongInfo[] = [];
  let active = -1;
  let timer = 0;
  let ctrl: AbortController | null = null;
  let shown = false;

  const renderIdle = () => {
    const recent = readRecent();
    const links = (items: { label: string; attr: string }[]) =>
      items
        .map((i) => `<button class="press text-dim underline decoration-line-strong underline-offset-4 hover:text-bone hover:decoration-dim" ${i.attr}>${esc(i.label)}</button>`)
        .join('<span class="px-2 text-faint">·</span>');
    status.innerHTML = `
      ${recent.length ? `<div class="mb-2"><span class="mr-3 text-faint">Recent</span>${links(recent.map((r) => ({ label: r.title, attr: `data-open="${r.songId}"` })))}</div>` : ''}
      <div><span class="mr-3 text-faint">Try</span>${links(SUGGESTIONS.map((s) => ({ label: s, attr: `data-q="${esc(s)}"` })))}</div>`;
    list.innerHTML = '';
    shown = false;
  };

  const render = () => {
    const stagger = !shown;
    list.innerHTML = results
      .map((s, i) => {
        const guitar = s.tracks.find((t) => t.index === s.guitarTrack);
        const parts = s.tracks.filter(isGuitar).length;
        return `<li role="option" id="r${i}" aria-selected="${i === active}" data-open="${s.songId}"
          class="${stagger ? 'reveal ' : ''}group -mx-3 flex cursor-pointer items-center gap-4 rounded-lg px-3 py-3 hover:bg-raise aria-selected:bg-raise"
          style="--delay:${stagger ? Math.min(i, 8) * 30 : 0}ms">
          <div class="min-w-0 flex-1">
            <div class="truncate text-[16px] font-medium tracking-[-0.01em]">${esc(s.title)}</div>
            <div class="truncate text-[14px] text-dim">${esc(s.artist)}</div>
          </div>
          <div class="hidden shrink-0 text-right font-mono text-[11px] text-faint sm:block">
            <div>${guitar?.tuning ? esc(tuningAdvice(guitar.tuning).label.replace(' (record is lower)', '')) : ''}</div>
            <div>${parts} guitar part${parts === 1 ? '' : 's'}</div>
          </div>
          <div class="w-4 shrink-0">${difficulty(guitar?.difficulty)}</div>
        </li>`;
      })
      .join('');
    shown = results.length > 0;
  };

  const run = (q: string) => {
    clearTimeout(timer);
    ctrl?.abort();
    if (!q.trim()) {
      results = [];
      renderIdle();
      return;
    }
    timer = window.setTimeout(async () => {
      ctrl = new AbortController();
      status.textContent = 'Searching…';
      try {
        results = await searchSongs(q, ctrl.signal);
        active = results.length ? 0 : -1;
        status.textContent = results.length ? '' : `Nothing with a guitar part for “${q.trim()}”.`;
        render();
      } catch (err) {
        if ((err as Error).name === 'AbortError') return;
        status.textContent = 'Search is unavailable right now. Check your connection.';
      }
    }, 220);
  };

  input.addEventListener('input', () => run(input.value));
  input.addEventListener('keydown', (e) => {
    if (!results.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length;
      list.querySelectorAll('li').forEach((li, i) => li.setAttribute('aria-selected', String(i === active)));
      list.querySelector(`#r${active}`)?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' && active >= 0) {
      open(results[active].songId);
    }
  });
  root.addEventListener('click', (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-open],[data-q]');
    if (!el) return;
    if (el.dataset.q) {
      input.value = el.dataset.q;
      run(el.dataset.q);
      input.focus();
    } else open(Number(el.dataset.open));
  });
  const slash = (e: KeyboardEvent) => {
    if (e.key === '/' && document.activeElement !== input) {
      e.preventDefault();
      input.focus();
    }
  };
  window.addEventListener('keydown', slash);

  input.value = initialQuery;
  if (initialQuery) run(initialQuery);
  else renderIdle();
  input.focus();
  return () => {
    window.removeEventListener('keydown', slash);
    ctrl?.abort();
    clearTimeout(timer);
  };
}
