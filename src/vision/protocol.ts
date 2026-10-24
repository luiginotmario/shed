export interface HandFrame {
  /** 21 landmarks × (x, y, z), normalized coords of the unmirrored frame. */
  lm: Float32Array;
}

export interface VisionFrame {
  /** Capture time (performance.now ms). */
  ts: number;
  /** Frame size, to correct the aspect ratio of normalized coords. */
  w: number;
  h: number;
  hands: HandFrame[];
  /** Inference time in ms. */
  ms: number;
}

export type ToVision =
  | { t: 'init'; wasmBase: string; model: string; fallback: string }
  | { t: 'frame'; bitmap: ImageBitmap; ts: number };

export type FromVision =
  | { t: 'ready'; delegate: string }
  | { t: 'error'; message: string }
  | { t: 'result'; frame: VisionFrame };
