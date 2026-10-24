import type { FromVision, ToVision, VisionFrame } from './protocol';

const CDN_MODEL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task';
/** Frames are downscaled before inference; the model runs at ≤256px anyway. */
const INFER_WIDTH = 384;

/**
 * Streams webcam frames to the vision worker with backpressure: a new frame is
 * only sent once the previous result is back, so latency never builds up.
 */
export class Camera {
  readonly video: HTMLVideoElement;
  private worker: Worker | null = null;
  private stream: MediaStream | null = null;
  private busy = false;
  private ready = false;
  private frameWaiting = false;
  private running = false;
  private session = 0;
  onResult?: (f: VisionFrame) => void;
  onStatus?: (s: 'starting' | 'loading' | 'live' | 'off' | 'error', detail?: string) => void;

  constructor(video: HTMLVideoElement) {
    this.video = video;
  }

  get active() {
    return this.running;
  }

  async start() {
    if (this.running) return;
    this.onStatus?.('starting');
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30, max: 30 } },
      });
    } catch (err) {
      this.onStatus?.('error', (err as Error).name === 'NotAllowedError' ? 'Camera access was blocked' : 'No camera found');
      return;
    }
    this.video.srcObject = this.stream;
    this.video.muted = true;
    this.video.playsInline = true;
    await this.video.play();
    this.running = true;

    if (!this.worker) {
      this.onStatus?.('loading');
      this.worker = new Worker(new URL('./vision.worker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e: MessageEvent<FromVision>) => this.handle(e.data);
      const base = new URL(import.meta.env.BASE_URL, location.href).href.replace(/\/$/, '');
      const init: ToVision = {
        t: 'init',
        wasmBase: `${base}/mediapipe`,
        model: `${base}/models/hand_landmarker.task`,
        fallback: CDN_MODEL,
      };
      this.worker.postMessage(init);
    } else if (this.ready) {
      this.onStatus?.('live');
    }
    this.watchFrames();
  }

  stop() {
    this.running = false;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
    this.onStatus?.('off');
  }

  private handle(msg: FromVision) {
    if (msg.t === 'ready') {
      this.ready = true;
      if (this.running) this.onStatus?.('live');
      this.pump();
    } else if (msg.t === 'error') {
      this.onStatus?.('error', 'Hand tracking failed to load');
      console.error('[vision]', msg.message);
    } else {
      this.busy = false;
      if (this.running) this.onResult?.(msg.frame);
      if (this.frameWaiting) this.pump();
    }
  }

  private watchFrames() {
    const v = this.video as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number };
    const session = ++this.session;
    const live = () => this.running && session === this.session;
    let lastCallback = 0;
    if (v.requestVideoFrameCallback) {
      const onFrame = () => {
        if (!live()) return;
        lastCallback = performance.now();
        this.frameWaiting = true;
        this.pump();
        v.requestVideoFrameCallback!(onFrame);
      };
      v.requestVideoFrameCallback(onFrame);
    }
    // Watchdog for browsers that pause frame callbacks or lack them.
    const poll = () => {
      if (!live()) return;
      if (performance.now() - lastCallback > 150) {
        this.frameWaiting = true;
        this.pump();
      }
      setTimeout(poll, 50);
    };
    poll();
  }

  private pump() {
    if (!this.ready || this.busy || !this.frameWaiting || !this.running || !this.worker) return;
    if (document.hidden) return;
    const vw = this.video.videoWidth, vh = this.video.videoHeight;
    if (!vw || !vh) return;
    this.busy = true;
    this.frameWaiting = false;
    const ts = performance.now();
    const w = Math.min(INFER_WIDTH, vw);
    const h = Math.round((w * vh) / vw);
    createImageBitmap(this.video, { resizeWidth: w, resizeHeight: h, resizeQuality: 'low' })
      .then((bitmap) => {
        const msg: ToVision = { t: 'frame', bitmap, ts };
        this.worker!.postMessage(msg, [bitmap]);
      })
      .catch(() => {
        this.busy = false;
      });
  }
}
