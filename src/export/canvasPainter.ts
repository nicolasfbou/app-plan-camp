/**
 * Surface canevas : aperçu d'impression et exports PNG / JPG. Le contexte est mis à l'échelle
 * (pixels par mm) : le code de mise en page dessine en mm, comme pour le PDF.
 */
import type { Point } from '@/domain/model/types.ts';
import { CANVAS_FONT_STACK } from './fonts.ts';
import {
  MM_PER_PT,
  textOrigin,
  type FillSpec,
  type Painter,
  type PainterImage,
  type StrokeSpec,
  type TextSpec,
} from './painter.ts';

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export function rgbaCss(hex: string, alpha: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

export class CanvasPainter implements Painter {
  readonly kind = 'canvas' as const;
  private alpha = 1;

  /** @param pxPerMm pixels du canevas par millimètre de page */
  constructor(
    private readonly c: Ctx,
    readonly pxPerMm: number,
  ) {
    c.setTransform(pxPerMm, 0, 0, pxPerMm, 0, 0);
    c.imageSmoothingEnabled = true;
    c.imageSmoothingQuality = 'high';
  }

  private trace(subpaths: readonly (readonly Point[])[], closed: boolean) {
    const c = this.c;
    c.beginPath();
    for (const sp of subpaths) {
      if (sp.length < 2) continue;
      c.moveTo(sp[0]!.x, sp[0]!.y);
      for (let i = 1; i < sp.length; i++) c.lineTo(sp[i]!.x, sp[i]!.y);
      if (closed) c.closePath();
    }
  }

  path(
    subpaths: readonly (readonly Point[])[],
    closed: boolean,
    fill: FillSpec | null,
    stroke: StrokeSpec | null,
  ) {
    const c = this.c;
    this.trace(subpaths, closed);
    if (fill && fill.opacity > 0) {
      c.fillStyle = rgbaCss(fill.color, fill.opacity * this.alpha);
      c.fill(fill.evenOdd ? 'evenodd' : 'nonzero');
    }
    if (stroke && stroke.opacity > 0 && stroke.width > 0) {
      c.strokeStyle = rgbaCss(stroke.color, stroke.opacity * this.alpha);
      c.lineWidth = stroke.width;
      c.lineCap = stroke.cap ?? 'butt';
      c.lineJoin = stroke.join ?? 'miter';
      c.miterLimit = 4;
      c.setLineDash(stroke.dash ?? []);
      c.stroke();
      c.setLineDash([]);
    }
  }

  private font(size: number, bold?: boolean) {
    return `${bold ? 700 : 400} ${size * MM_PER_PT}px ${CANVAS_FONT_STACK}`;
  }

  textWidth(text: string, size: number, bold?: boolean): number {
    this.c.font = this.font(size, bold);
    return this.c.measureText(text).width;
  }

  text(text: string, x: number, y: number, spec: TextSpec) {
    const c = this.c;
    const width = this.textWidth(text, spec.size, spec.bold);
    const o = textOrigin(width, x, y, spec);
    c.save();
    c.translate(o.x, o.y);
    if (spec.angle) c.rotate((spec.angle * Math.PI) / 180);
    c.font = this.font(spec.size, spec.bold);
    c.textAlign = 'left';
    c.textBaseline = 'alphabetic';
    if (spec.halo && spec.halo.width > 0) {
      c.lineJoin = 'round';
      c.lineWidth = spec.halo.width * 2;
      c.strokeStyle = rgbaCss(spec.halo.color, (spec.halo.opacity ?? 1) * this.alpha);
      c.strokeText(text, 0, 0);
    }
    c.fillStyle = rgbaCss(spec.color, (spec.opacity ?? 1) * this.alpha);
    c.fillText(text, 0, 0);
    c.restore();
  }

  image(image: PainterImage, x: number, y: number, width: number, height: number, opacity = 1) {
    const c = this.c;
    c.save();
    c.globalAlpha = opacity * this.alpha;
    c.drawImage(image.drawable, x, y, width, height);
    c.restore();
  }

  clip(subpaths: readonly (readonly Point[])[], draw: () => void) {
    this.c.save();
    this.trace(subpaths, true);
    this.c.clip();
    try {
      draw();
    } finally {
      this.c.restore();
    }
  }

  withOpacity(opacity: number, draw: () => void) {
    const previous = this.alpha;
    this.alpha *= opacity;
    try {
      draw();
    } finally {
      this.alpha = previous;
    }
  }
}
