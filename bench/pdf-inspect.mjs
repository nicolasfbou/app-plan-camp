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
      // Texte de toutes les pages (rapports sur plusieurs pages).
      let allText = '';
      for (let n = 1; n <= doc.numPages; n++)
        allText += `${(await (await doc.getPage(n)).getTextContent()).items.map((i) => i.str).join('\n')}\n`;
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
      // Boîtes (mm, origine en haut à gauche) des textes et des images, pour vérifier les
      // chevauchements et les débordements. Textes doublés (liseré puis remplissage) dédoublonnés.
      const H = viewport.height;
      const mm = 25.4 / 72;
      const seen = new Set();
      const texts = [];
      for (const item of (await page.getTextContent()).items) {
        if (!item.str.trim()) continue;
        const [a, b, , , e, f] = item.transform;
        const size = Math.hypot(a, b);
        const key = `${item.str}|${e.toFixed(2)}|${f.toFixed(2)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        texts.push({
          str: item.str,
          sizePt: size,
          rotated: Math.abs(b) > 1e-6,
          x: e * mm,
          y: (H - f - size * 0.74) * mm,
          width: item.width * mm,
          height: size * 0.95 * mm,
        });
      }
      const images = [];
      let ctm = [1, 0, 0, 1, 0, 0];
      const stack = [];
      const mul = (m, n) => [
        m[0] * n[0] + m[2] * n[1],
        m[1] * n[0] + m[3] * n[1],
        m[0] * n[2] + m[2] * n[3],
        m[1] * n[2] + m[3] * n[3],
        m[0] * n[4] + m[2] * n[5] + m[4],
        m[1] * n[4] + m[3] * n[5] + m[5],
      ];
      for (let i = 0; i < ops.fnArray.length; i++) {
        const fn = ops.fnArray[i];
        if (fn === pdfjs.OPS.save) stack.push(ctm);
        else if (fn === pdfjs.OPS.restore) ctm = stack.pop() ?? [1, 0, 0, 1, 0, 0];
        else if (fn === pdfjs.OPS.transform) ctm = mul(ctm, ops.argsArray[i]);
        else if (fn === pdfjs.OPS.paintImageXObject) {
          const w = Math.abs(ctm[0]);
          const h = Math.abs(ctm[3]);
          images.push({ x: ctm[4] * mm, y: (H - ctm[5] - h) * mm, width: w * mm, height: h * mm });
        }
      }
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
        allText,
        operators: counts,
        fonts: [...fonts],
        texts,
        images,
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
  console.log(
    JSON.stringify(
      { ...r, png: undefined, texts: r.texts.length, images: r.images.length, text: r.text.slice(0, 2000) },
      null,
      2,
    ),
  );
  await browser.close();
}

/** Chevauchements (texte / texte, texte / image, image / image) et éléments hors de la page. */
export function layoutProblems(info, { photoMinMm = 100, tolerance = 0.2 } = {}) {
  const inter = (a, b) =>
    Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) > tolerance &&
    Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) > tolerance;
  const icons = info.images.filter((i) => i.width < photoMinMm && i.height < photoMinMm);
  const boxes = [
    ...info.texts.filter((t) => !t.rotated).map((t) => ({ ...t, kind: 'texte', label: t.str })),
    ...icons.map((i, n) => ({
      ...i,
      kind: 'image',
      label: `image ${n + 1} (${i.x.toFixed(0)}, ${i.y.toFixed(0)} mm)`,
    })),
  ];
  const overlaps = [];
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++)
      if (inter(boxes[i], boxes[j]))
        overlaps.push(`${boxes[i].kind} « ${boxes[i].label} » ↔ ${boxes[j].kind} « ${boxes[j].label} »`);
  const outside = [...boxes, ...info.images.map((i) => ({ ...i, label: 'photo' }))]
    .filter(
      (b) =>
        b.x < -0.01 ||
        b.y < -0.01 ||
        b.x + b.width > info.widthMm + 0.01 ||
        b.y + b.height > info.heightMm + 0.01,
    )
    .map((b) => b.label);
  const minTextPt = Math.min(...info.texts.map((t) => t.sizePt));
  return { overlaps, outside, minTextPt };
}
