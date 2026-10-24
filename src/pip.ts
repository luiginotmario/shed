import { neckPoint, type Neck, type Roles } from './coach';
import type { VisionFrame } from './vision/protocol';

const BONES = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20], [0, 17],
];

export interface Overlay {
  roles: Roles;
  neck: Neck | null;
  /** Index tip being held for calibration, 0..1 progress. */
  calibrating: number | null;
  /** ms since the last detected pick stroke, for a brief flash. */
  sinceStroke: number;
}

/** Draws the mirrored camera view with both hands and the neck line. */
export class PipOverlay {
  private ctx: CanvasRenderingContext2D;
  private w = 0;
  private h = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
    new ResizeObserver(() => {
      const r = canvas.getBoundingClientRect();
      const dpr = Math.min(2, devicePixelRatio || 1);
      this.w = r.width;
      this.h = r.height;
      canvas.width = Math.round(r.width * dpr);
      canvas.height = Math.round(r.height * dpr);
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }).observe(canvas);
  }

  clear() {
    this.ctx.clearRect(0, 0, this.w, this.h);
  }

  draw(frame: VisionFrame, o: Overlay) {
    const { ctx, w: W, h: H } = this;
    ctx.clearRect(0, 0, W, H);
    // Same mapping as the mirrored, object-fit: cover video.
    const ar = frame.w / frame.h;
    const sx = ar > W / H ? H * ar : W;
    const sy = ar > W / H ? H : W / ar;
    const ox = (W - sx) / 2, oy = (H - sy) / 2;
    const px = (x: number) => ox + (1 - x) * sx;
    const py = (y: number) => oy + y * sy;

    if (o.neck) {
      const a = neckPoint(o.neck, 0), b = neckPoint(o.neck, 15);
      const toPx = (p: { x: number; y: number }) => [px(p.x / ar), py(p.y)] as const;
      const [ax, ay] = toPx(a), [bx, by] = toPx(b);
      ctx.strokeStyle = 'rgba(236, 228, 212, 0.35)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.stroke();
      ctx.fillStyle = 'rgba(236, 228, 212, 0.55)';
      for (const f of [3, 5, 7, 9, 12]) {
        const [fx, fy] = toPx(neckPoint(o.neck, f));
        ctx.beginPath();
        ctx.arc(fx, fy, f === 12 ? 2.5 : 1.8, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    const hand = (lm: Float32Array, color: string, width: number) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.lineCap = 'round';
      ctx.beginPath();
      for (const [a, b] of BONES) {
        ctx.moveTo(px(lm[a * 3]), py(lm[a * 3 + 1]));
        ctx.lineTo(px(lm[b * 3]), py(lm[b * 3 + 1]));
      }
      ctx.stroke();
    };
    if (o.roles.fret) hand(o.roles.fret, 'rgba(236, 228, 212, 0.9)', 1.75);
    if (o.roles.pick) {
      const flash = Math.max(0, 1 - o.sinceStroke / 220);
      hand(o.roles.pick, `rgba(227, 162, 74, ${0.75 + 0.25 * flash})`, 1.75 + flash * 1.5);
      // The pick grip: between thumb and index tips.
      const lm = o.roles.pick;
      const gx = px((lm[12] + lm[24]) / 2), gy = py((lm[13] + lm[25]) / 2);
      ctx.fillStyle = 'rgb(227, 162, 74)';
      ctx.beginPath();
      ctx.arc(gx, gy, 3 + flash * 3, 0, Math.PI * 2);
      ctx.fill();
    }
    if (o.calibrating != null && o.roles.fret) {
      const lm = o.roles.fret;
      const tx = px(lm[24]), ty = py(lm[25]);
      ctx.strokeStyle = 'rgba(236, 228, 212, 0.25)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(tx, ty, 11, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = 'rgb(236, 228, 212)';
      ctx.beginPath();
      ctx.arc(tx, ty, 11, -Math.PI / 2, -Math.PI / 2 + o.calibrating * Math.PI * 2);
      ctx.stroke();
    }
  }
}
