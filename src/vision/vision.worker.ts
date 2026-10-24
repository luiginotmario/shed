// Runs MediaPipe hand landmarking off the main thread.
import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';
import type { FromVision, HandFrame, ToVision } from './protocol';

let hands: HandLandmarker | null = null;
let lastTs = 0;

const post = (msg: FromVision) => (self as unknown as Worker).postMessage(msg);

async function reachable(url: string) {
  try {
    const r = await fetch(url, { method: 'HEAD' });
    const len = Number(r.headers.get('content-length') ?? '0');
    return r.ok && !(r.headers.get('content-type') ?? '').includes('text/html') && (len === 0 || len > 10_000);
  } catch {
    return false;
  }
}

// MediaPipe loads its wasm glue with import() in module workers and clears the
// global ModuleFactory after creating a task, so a CPU retry after a failed GPU
// attempt would find nothing. Keep a reference and restore it before creating.
let factory: unknown = null;
async function restoreFactory(loaderPath: string) {
  if (!factory) factory = ((await import(/* @vite-ignore */ loaderPath)) as { default: unknown }).default;
  (self as unknown as { ModuleFactory: unknown }).ModuleFactory = factory;
}

async function create(msg: Extract<ToVision, { t: 'init' }>, delegate: 'GPU' | 'CPU') {
  const fileset = await FilesetResolver.forVisionTasks(msg.wasmBase, true);
  const model = (await reachable(msg.model)) ? msg.model : msg.fallback;
  await restoreFactory(fileset.wasmLoaderPath);
  return HandLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: model, delegate },
    runningMode: 'VIDEO',
    numHands: 2,
    minHandDetectionConfidence: 0.5,
    minHandPresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
}

async function init(msg: Extract<ToVision, { t: 'init' }>) {
  let delegate: 'GPU' | 'CPU' = 'GPU';
  try {
    hands = await create(msg, 'GPU');
  } catch (err) {
    console.warn('[vision] GPU delegate failed, using CPU', err);
    delegate = 'CPU';
    try {
      hands = await create(msg, 'CPU');
    } catch (err2) {
      post({ t: 'error', message: String((err2 as Error)?.message ?? err2) });
      return;
    }
  }
  // The first inference compiles GPU shaders, which takes seconds. Do it now,
  // behind the loading state, instead of on the first real frame.
  try {
    const c = new OffscreenCanvas(384, 288);
    c.getContext('2d')!.fillRect(0, 0, 384, 288);
    const bm = c.transferToImageBitmap();
    lastTs = 1;
    hands.detectForVideo(bm, lastTs);
    bm.close();
  } catch (err) {
    console.warn('[vision] warm-up failed', err);
  }
  post({ t: 'ready', delegate });
}

function frame(bitmap: ImageBitmap, ts: number) {
  if (!hands) {
    bitmap.close();
    return;
  }
  // MediaPipe requires strictly increasing timestamps.
  const t = Math.max(ts, lastTs + 1);
  lastTs = t;
  const start = performance.now();
  const res = hands.detectForVideo(bitmap, t);
  const ms = performance.now() - start;
  const out: HandFrame[] = res.landmarks.map((src) => {
    const lm = new Float32Array(63);
    for (let j = 0; j < 21; j++) {
      lm[j * 3] = src[j].x;
      lm[j * 3 + 1] = src[j].y;
      lm[j * 3 + 2] = src[j].z;
    }
    return { lm };
  });
  const w = bitmap.width, h = bitmap.height;
  bitmap.close();
  post({ t: 'result', frame: { ts, w, h, hands: out, ms } });
}

self.onmessage = (e: MessageEvent<ToVision>) => {
  const msg = e.data;
  if (msg.t === 'init') void init(msg);
  else if (msg.t === 'frame') {
    try {
      frame(msg.bitmap, msg.ts);
    } catch (err) {
      msg.bitmap.close();
      console.error('[vision] frame failed', err);
      post({ t: 'result', frame: { ts: msg.ts, w: 1, h: 1, hands: [], ms: 0 } });
    }
  }
};
