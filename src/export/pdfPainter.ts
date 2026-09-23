/**
 * Surface PDF (jsPDF) : contours, surfaces et textes VECTORIELS ; la photo et les pictogrammes en
 * images. La police Liberation Sans est intégrée (accents, « ≈ », « ² »). Les coordonnées reçues
 * sont en mm de page, comme l'unité du document.
 */
import { GState, type jsPDF } from 'jspdf';
import type { Point } from '@/domain/model/types.ts';
import { toBase64, type ExportFonts } from './fonts.ts';
import {
  textOrigin,
  type FillSpec,
  type Painter,
  type PainterImage,
  type StrokeSpec,
  type TextSpec,
} from './painter.ts';

export const PDF_FONT = 'LiberationSans';

/** Déclare la police intégrée au document. */
export function registerPdfFonts(doc: jsPDF, fonts: ExportFonts): void {
  doc.addFileToVFS('LiberationSans-Regular.ttf', toBase64(fonts.regular));
  doc.addFont('LiberationSans-Regular.ttf', PDF_FONT, 'normal');
  doc.addFileToVFS('LiberationSans-Bold.ttf', toBase64(fonts.bold));
  doc.addFont('LiberationSans-Bold.ttf', PDF_FONT, 'bold');
  doc.setFont(PDF_FONT, 'normal');
}

export class PdfPainter implements Painter {
  readonly kind = 'pdf' as const;
  private alpha = 1;
  private readonly states = new Map<string, GState>();
  /** Octets déjà préparés par image : une image répétée n'est convertie et intégrée qu'une fois. */
  private readonly images = new Map<string, { bytes: Uint8Array; format: 'JPEG' | 'PNG' }>();

  constructor(private readonly doc: jsPDF) {}

  private opacity(fill: number, stroke: number) {
    const f = Math.round(fill * this.alpha * 1000) / 1000;
    const s = Math.round(stroke * this.alpha * 1000) / 1000;
    const key = `${f}|${s}`;
    let state = this.states.get(key);
    if (!state) {
      state = new GState({ opacity: f, 'stroke-opacity': s });
      this.states.set(key, state);
    }
    this.doc.setGState(state);
  }

  private trace(subpaths: readonly (readonly Point[])[], closed: boolean): boolean {
    let any = false;
    for (const sp of subpaths) {
      if (sp.length < 2) continue;
      this.doc.moveTo(sp[0]!.x, sp[0]!.y);
      for (let i = 1; i < sp.length; i++) this.doc.lineTo(sp[i]!.x, sp[i]!.y);
      if (closed) this.doc.close();
      any = true;
    }
    return any;
  }

  path(
    subpaths: readonly (readonly Point[])[],
    closed: boolean,
    fill: FillSpec | null,
    stroke: StrokeSpec | null,
  ) {
    const doFill = !!fill && fill.opacity > 0 && closed;
    const doStroke = !!stroke && stroke.opacity > 0 && stroke.width > 0;
    if (!doFill && !doStroke) return;
    const d = this.doc;
    this.opacity(doFill ? fill.opacity : 1, doStroke ? stroke.opacity : 1);
    if (doFill) d.setFillColor(fill.color);
    if (doStroke) {
      d.setDrawColor(stroke.color);
      d.setLineWidth(stroke.width);
      d.setLineCap(stroke.cap ?? 'butt');
      d.setLineJoin(stroke.join ?? 'miter');
      d.setLineDashPattern(stroke.dash ?? [], 0);
    }
    if (!this.trace(subpaths, closed)) return;
    if (doFill && doStroke) {
      if (fill.evenOdd) d.fillStrokeEvenOdd();
      else d.fillStroke();
    } else if (doFill) {
      if (fill.evenOdd) d.fillEvenOdd();
      else d.fill();
    } else d.stroke();
    if (doStroke && stroke.dash?.length) d.setLineDashPattern([], 0);
  }

  textWidth(text: string, size: number, bold?: boolean): number {
    this.doc.setFont(PDF_FONT, bold ? 'bold' : 'normal');
    this.doc.setFontSize(size);
    return this.doc.getTextWidth(text);
  }

  text(text: string, x: number, y: number, spec: TextSpec) {
    if (!text) return;
    const d = this.doc;
    const width = this.textWidth(text, spec.size, spec.bold);
    const o = textOrigin(width, x, y, spec);
    // jsPDF : angle en degrés, sens anti-horaire ; ici, sens horaire (comme le reste du plan).
    const options = { baseline: 'alphabetic' as const, angle: spec.angle ? -spec.angle : 0 };
    if (spec.halo && spec.halo.width > 0) {
      this.opacity(1, spec.halo.opacity ?? 1);
      d.setDrawColor(spec.halo.color);
      d.setLineWidth(spec.halo.width * 2);
      d.setLineJoin('round');
      d.text(text, o.x, o.y, { ...options, renderingMode: 'stroke' });
    }
    this.opacity(spec.opacity ?? 1, 1);
    d.setTextColor(spec.color);
    d.text(text, o.x, o.y, { ...options, renderingMode: 'fill' });
  }

  image(image: PainterImage, x: number, y: number, width: number, height: number, opacity = 1) {
    let data = this.images.get(image.key);
    if (!data) {
      data = image.jpeg
        ? { bytes: image.jpeg, format: 'JPEG' }
        : { bytes: pngBytes(image.drawable), format: 'PNG' };
      this.images.set(image.key, data);
    }
    this.opacity(opacity, 1);
    // Même alias = même objet image dans le PDF (réutilisé, jamais dupliqué).
    this.doc.addImage(
      data.bytes,
      data.format,
      x,
      y,
      width,
      height,
      image.key,
      data.format === 'JPEG' ? 'NONE' : 'FAST',
    );
  }

  clip(subpaths: readonly (readonly Point[])[], draw: () => void) {
    const d = this.doc;
    d.saveGraphicsState();
    if (this.trace(subpaths, true)) {
      d.clip();
      d.discardPath();
    }
    try {
      draw();
    } finally {
      d.restoreGraphicsState();
    }
  }

  withOpacity(opacity: number, draw: () => void) {
    const previous = this.alpha;
    this.alpha *= opacity;
    try {
      draw();
    } finally {
      this.alpha = previous;
      this.opacity(1, 1);
    }
  }
}

/** Bitmap → octets PNG (sans perte, transparence conservée). */
function pngBytes(source: CanvasImageSource): Uint8Array {
  let canvas = source as HTMLCanvasElement;
  if (!(source instanceof HTMLCanvasElement)) {
    const w = (source as { width: number }).width;
    const h = (source as { height: number }).height;
    canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d')!.drawImage(source, 0, 0);
  }
  const base64 = canvas.toDataURL('image/png').split(',')[1] ?? '';
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
