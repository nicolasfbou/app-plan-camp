/**
 * Inspection d'un PDF exporté avec pdf.js (dans Chromium) : pages, taille, texte extrait, polices,
 * images, opérateurs vectoriels, et rendu PNG de la première page.
 * Usage : node bench/pdf-inspect.mjs <fichier.pdf> [rendu.png] [échelle]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

export async function inspectPdf(browser, pdfBytes, { renderScale = 0 } = {}) {
  const page = await browser.newPage();
  const root = new URL('../node_modules/pdfjs-dist/legacy/build/', import.meta.url);
  await page.route('http://pdfjs.local/**', (route) => {
    const name = new URL(route.request().url()).pathname.slice(1);
    if (name === 'index.html')
      return route.fulfill({ contentType: 'text/html', body: '<!doctype html><body></body>' });
    return route.fulfill({ contentType: 'text/javascript', body: readFileSync(new URL(name, root)) });
  });
  await page.goto('http://pdfjs.local/index.html');
  const result = await page.evaluate(
    async ({ data, renderScale }) => {
      const pdfjs = await import('http://pdfjs.local/pdf.mjs');
      pdfjs.GlobalWorkerOptions.workerSrc = 'http://pdfjs.local/pdf.worker.mjs';
      const doc = await pdfjs.getDocument({ data: new Uint8Array(data) }).promise;
      const page = await doc.getPage(1);
      const viewport = page.getViewport({ scale: 1 });
      const text = (await page.getTextContent()).items.map((i) => i.str).join('\n');
      const ops = await page.getOperatorList();
      const names = Object.fromEntries(Object.entries(pdfjs.OPS).map(([k, v]) => [v, k]));
      const counts = {};
      for (const fn of ops.fnArray) counts[names[fn]] = (counts[names[fn]] ?? 0) + 1;
      const fonts = new Set();
      for (let i = 0; i < ops.fnArray.length; i++)
        if (ops.fnArray[i] === pdfjs.OPS.setFont)
          fonts.add(
            page.commonObjs.has(ops.argsArray[i][0])
              ? page.commonObjs.get(ops.argsArray[i][0]).name
              : ops.argsArray[i][0],
          );
      let png = null;
      if (renderScale > 0) {
        const vp = page.getViewport({ scale: renderScale });
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(vp.width);
        canvas.height = Math.round(vp.height);
        await page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
        png = canvas.toDataURL('image/png');
      }
      return {
        pages: doc.numPages,
        widthMm: (viewport.width * 25.4) / 72,
        heightMm: (viewport.height * 25.4) / 72,
        text,
        operators: counts,
        fonts: [...fonts],
        png,
      };
    },
    { data: [...pdfBytes], renderScale },
  );
  await page.close();
  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [file, out, scale] = process.argv.slice(2);
  const browser = await chromium.launch({
    executablePath: process.env.PW_CHROMIUM_PATH ?? '/opt/pw-browsers/chromium',
  });
  const r = await inspectPdf(browser, readFileSync(file), { renderScale: out ? Number(scale ?? 2) : 0 });
  if (out && r.png) writeFileSync(out, Buffer.from(r.png.split(',')[1], 'base64'));
  console.log(JSON.stringify({ ...r, png: undefined, text: r.text.slice(0, 2000) }, null, 2));
  await browser.close();
}
