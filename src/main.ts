import './style.css';
import { Transport } from './audio';
import { mountPlayer } from './player';
import { mountSearch } from './search';
import { Camera } from './vision/camera';

const app = document.getElementById('app')!;
// One audio context and one camera for the whole session, shared across songs.
const transport = new Transport();
const camera = new Camera(document.createElement('video'));
let unmount: (() => void) | null = null;
let lastQuery = '';

/** Routes: `#/` search, `#/song/{id}` or `#/song/{id}/{track}` player. */
function route() {
  unmount?.();
  const m = location.hash.match(/^#\/song\/(\d+)(?:\/(\d+))?/);
  if (m) {
    const songId = Number(m[1]);
    unmount = mountPlayer(app, {
      songId,
      track: m[2] != null ? Number(m[2]) : undefined,
      transport,
      camera,
      back: () => (location.hash = '#/'),
      switchTrack: (i) => (location.hash = `#/song/${songId}/${i}`),
    });
  } else {
    document.title = 'Shed';
    // The camera only matters while playing.
    if (camera.active) camera.stop();
    unmount = mountSearch(app, (id) => (location.hash = `#/song/${id}`), lastQuery);
    const q = app.querySelector<HTMLInputElement>('#q');
    q?.addEventListener('input', () => (lastQuery = q.value));
  }
}

addEventListener('hashchange', route);
route();
