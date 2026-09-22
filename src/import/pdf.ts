/**
 * Lecture et rendu de PDF avec pdf.js, chargé à la demande (il n'alourdit pas le démarrage).
 * pdf.js reçoit toujours une COPIE des octets : l'original n'est jamais transféré ni modifié.
 *
 * On utilise le build « legacy » : le build standard de pdf.js 6 exige des fonctions JavaScript
 * très récentes (ex. `Map.prototype.getOrInsertComputed`) absentes de navigateurs encore courants.
 */
import type { PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { ImportError } from './errors.ts';

export interface PdfPageSize {
  widthPt: number;
  heightPt: number;
}

export interface LoadedPdf {
  pageCount: number;
  pageSize(page: number): Promise<PdfPageSize>;
  /** Vignette PNG (URL de données) dont le plus grand côté mesure `maxSide` pixels. */
  thumbnail(page: number, maxSide: number): Promise<string>;
  /** Rendu sans perte (PNG) de la page à la résolution demandée. */
  renderPng(page: number, dpi: number): Promise<ArrayBuffer>;
  destroy(): Promise<void>;
}

async function loadPdfJs() {
  const [pdfjs, worker] = await Promise.all([
    import('pdfjs-dist/legacy/build/pdf.mjs'),
    import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'),
  ]);
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  return pdfjs;
}

async function renderToCanvas(doc: PDFDocumentProxy, pageNumber: number, scale: number) {
  const page = await doc.getPage(pageNumber);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  const context = canvas.getContext('2d');
  if (!context) throw new ImportError('Impossible de créer un canevas pour le rendu du PDF.');
  // Fond blanc explicite : une page PDF sans fond serait sinon transparente.
  await page.render({ canvas, canvasContext: context, viewport, background: '#ffffff' }).promise;
  page.cleanup();
  return canvas;
}

export async function openPdf(bytes: ArrayBuffer): Promise<LoadedPdf> {
  const pdfjs = await loadPdfJs();
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes.slice(0)) });
  let doc: PDFDocumentProxy;
  try {
    doc = await task.promise;
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    void task.destroy();
    if (name === 'PasswordException') throw new ImportError('Ce PDF est protégé par un mot de passe.');
    throw new ImportError('Ce PDF est illisible ou corrompu.');
  }
  const pageSize = async (pageNumber: number): Promise<PdfPageSize> => {
    const viewport = (await doc.getPage(pageNumber)).getViewport({ scale: 1 });
    return { widthPt: viewport.width, heightPt: viewport.height };
  };
  return {
    pageCount: doc.numPages,
    pageSize,
    async thumbnail(pageNumber, maxSide) {
      const { widthPt, heightPt } = await pageSize(pageNumber);
      const canvas = await renderToCanvas(doc, pageNumber, maxSide / Math.max(widthPt, heightPt));
      return canvas.toDataURL('image/png');
    },
    async renderPng(pageNumber, dpi) {
      const canvas = await renderToCanvas(doc, pageNumber, dpi / 72);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
      canvas.width = canvas.height = 0; // libère la mémoire du canevas
      if (!blob) throw new ImportError('Le rendu de la page PDF a échoué (mémoire insuffisante ?).');
      return blob.arrayBuffer();
    },
    destroy: () => task.destroy(),
  };
}
