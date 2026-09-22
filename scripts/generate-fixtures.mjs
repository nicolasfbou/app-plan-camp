/**
 * Génère les fichiers de test e2e (reproductibles). Usage : node scripts/generate-fixtures.mjs
 * Motif « quadrants » 320 × 200 : haut-gauche rouge, haut-droite vert, bas-gauche bleu,
 * bas-droite jaune, damier 1 px au centre. Permet de vérifier l'orientation et l'exactitude des pixels.
 */
import { writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const out = new URL('../e2e/fixtures/', import.meta.url);
const write = (name, data) => writeFileSync(new URL(name, out), data);

const browser = await chromium.launch(
  process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {},
);
const page = await browser.newPage();
const encoded = await page.evaluate(async () => {
  const draw = (rotated) => {
    const canvas = document.createElement('canvas');
    canvas.width = rotated ? 200 : 320;
    canvas.height = rotated ? 320 : 200;
    const ctx = canvas.getContext('2d');
    if (rotated) {
      // Image stockée tournée de 90° antihoraire : l'orientation EXIF 6 la redresse.
      ctx.translate(0, 320);
      ctx.rotate(-Math.PI / 2);
    }
    const quad = [
      ['#ff0000', 0, 0],
      ['#00ff00', 160, 0],
      ['#0000ff', 0, 100],
      ['#ffff00', 160, 100],
    ];
    for (const [color, x, y] of quad) {
      ctx.fillStyle = color;
      ctx.fillRect(x, y, 160, 100);
    }
    for (let y = 90; y < 110; y++)
      for (let x = 150; x < 170; x++) {
        ctx.fillStyle = (x + y) % 2 ? '#000000' : '#ffffff';
        ctx.fillRect(x, y, 1, 1);
      }
    return canvas;
  };
  const toBytes = async (canvas, type, quality) =>
    Array.from(
      new Uint8Array(await (await new Promise((r) => canvas.toBlob(r, type, quality))).arrayBuffer()),
    );
  return {
    png: await toBytes(draw(false), 'image/png'),
    jpg: await toBytes(draw(false), 'image/jpeg', 0.95),
    webp: await toBytes(draw(false), 'image/webp', 1),
    rotatedJpg: await toBytes(draw(true), 'image/jpeg', 0.95),
  };
});
await browser.close();

write('quadrants.png', Buffer.from(encoded.png));
write('quadrants.jpg', Buffer.from(encoded.jpg));
write('quadrants.webp', Buffer.from(encoded.webp));

// JPEG avec EXIF Orientation = 6 inséré juste après SOI (les octets image ne changent pas).
const tiff = Buffer.from([
  0x49, 0x49, 42, 0, 8, 0, 0, 0, 1, 0, 0x12, 0x01, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0,
]);
const exifPayload = Buffer.concat([Buffer.from('Exif\0\0', 'binary'), tiff]);
const app1 = Buffer.concat([
  Buffer.from([0xff, 0xe1, (exifPayload.length + 2) >> 8, (exifPayload.length + 2) & 255]),
  exifPayload,
]);
const rotated = Buffer.from(encoded.rotatedJpg);
write('rotated-exif6.jpg', Buffer.concat([rotated.subarray(0, 2), app1, rotated.subarray(2)]));

// PDF de 2 pages (lettre) écrit à la main, avec table xref exacte.
function makePdf(pages) {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>'];
  const kids = pages.map((_, i) => `${3 + i * 2} 0 R`).join(' ');
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  pages.forEach((content, i) => {
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${4 + i * 2} 0 R >>`);
    objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  });
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) pdf += `${String(o).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}
write(
  'plan-2-pages.pdf',
  makePdf(['1 0 0 rg 72 396 234 324 re f 0 0 1 rg 306 72 234 324 re f', '0 0.6 0 rg 100 100 412 592 re f']),
);

// Fichiers invalides.
write('not-an-image.jpg', Buffer.from('Ceci est un fichier texte renommé en .jpg\n'));
write('broken.pdf', Buffer.from('%PDF-1.7\nceci n’est pas un vrai PDF\n%%EOF\n'));

// En-tête PNG annonçant 40 000 × 30 000 px (1,2 gigapixel) : jamais décodé, sert à tester l'alerte.
const ihdr = Buffer.alloc(33);
Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(ihdr, 0);
ihdr.writeUInt32BE(13, 8);
ihdr.write('IHDR', 12, 'latin1');
ihdr.writeUInt32BE(40000, 16);
ihdr.writeUInt32BE(30000, 20);
ihdr.set([8, 2, 0, 0, 0], 24);
write('huge-header.png', ihdr);

console.log('Fichiers de test générés dans e2e/fixtures/');
