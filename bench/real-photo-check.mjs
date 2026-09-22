/**
 * Test visuel d'attache des annotations sur une vraie photo.
 * Usage : node bench/real-photo-check.mjs <photo> <annotations.json> <dossier-captures>
 * Prérequis : `npm run build && npx vite preview --port 4178`.
 *
 * 1. crée un camp, un plan, importe la photo (jamais modifiée) ;
 * 2. dessine chaque annotation AVEC LES VRAIS OUTILS (coordonnées image → écran) ;
 * 3. pour chaque zoom (12,5 → 400 %) et chaque annotation, centre la vue dessus (préférence de vue),
 *    rouvre le plan, capture l'écran et vérifie numériquement que l'objet affiché coïncide avec sa
 *    géométrie enregistrée en pixels image ;
 * 4. vérifie que l'empreinte SHA-256 de la photo est inchangée.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const [photo, annotationsPath, outDir] = process.argv.slice(2);
if (!photo || !annotationsPath || !outDir)
  throw new Error('Usage : node bench/real-photo-check.mjs <photo> <annotations.json> <dossier>');
const annotations = JSON.parse(readFileSync(annotationsPath, 'utf8'));
const APP = process.env.APP_URL ?? 'http://localhost:4178/';
const ZOOMS = [0.125, 0.25, 0.5, 1, 2, 4];
mkdirSync(outDir, { recursive: true });
const photoSha = createHash('sha256').update(readFileSync(photo)).digest('hex');

const browser = await chromium.launch(
  process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {},
);
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
await page.goto(APP);
await page.getByRole('button', { name: 'Nouveau camp' }).click();
await page.getByLabel('Nom du camp').fill('Camp réel');
await page.getByRole('button', { name: 'Créer' }).click();
await page.getByRole('button', { name: 'Nouveau plan' }).click();
await page.getByRole('button', { name: 'Créer' }).click();
await page.getByTestId('import-input').setInputFiles(photo);
const openAnyway = page.getByRole('button', { name: 'Ouvrir quand même' });
await Promise.race([
  page.getByTestId('navigation-controls').waitFor({ timeout: 120_000 }),
  openAnyway.click({ timeout: 120_000 }).catch(() => {}),
]);
await page.getByTestId('navigation-controls').waitFor({ timeout: 120_000 });

const box = await page.getByTestId('canvas-container').boundingBox();
const transform = () =>
  page.evaluate(() => {
    const s = window.Konva.stages[0];
    return { x: s.x(), y: s.y(), scale: s.scaleX() };
  });
const toScreen = async ([x, y]) => {
  const t = await transform();
  return [box.x + x * t.scale + t.x, box.y + y * t.scale + t.y];
};

for (const a of annotations) {
  if (a.preset)
    await page.evaluate((id) => document.querySelector(`[data-preset="${id}"]`)?.click(), a.preset);
  const key = { rect: 'r', ellipse: 'e', polygon: 'p', polyline: 'k', line: 'l', label: 'g', text: 't' }[
    a.tool
  ];
  await page.keyboard.press(key);
  if (a.tool === 'rect' || a.tool === 'ellipse' || a.tool === 'line') {
    const [s, e] = [await toScreen(a.points[0]), await toScreen(a.points[1])];
    await page.mouse.move(...s);
    await page.mouse.down();
    await page.mouse.move(...e, { steps: 8 });
    await page.mouse.up();
  } else if (a.tool === 'polygon' || a.tool === 'polyline') {
    for (const p of a.points) await page.mouse.click(...(await toScreen(p)));
    await page.keyboard.press('Enter');
  } else {
    await page.mouse.click(...(await toScreen(a.at)));
    await page.getByTestId('text-editor').fill(a.text);
    await page.keyboard.press('Enter');
  }
  await page.keyboard.press('Escape');
}
await page
  .getByTestId('save-status')
  .filter({ hasText: /^Enregistré$/ })
  .waitFor({ timeout: 30_000 });

// Vue d'ensemble de l'application : adapter à l'écran, dernière annotation sélectionnée.
await page.keyboard.press('0');
const last = await page.evaluate(() => {
  const r = window.Konva.stages[0].find('.plan-object').at(-1).getClientRect();
  return [r.x + r.width / 2, r.y + r.height / 2];
});
await page.mouse.click(box.x + last[0], box.y + last[1]);
await page.waitForTimeout(6500); // laisse disparaître la notification « hors ligne »
await page.screenshot({ path: `${outDir}/application.png` });

const stored = await page.evaluate(
  () =>
    new Promise((resolve) => {
      const open = indexedDB.open('campplanner');
      open.onsuccess = () => {
        const r = open.result.transaction('plans').objectStore('plans').getAll();
        r.onsuccess = () => {
          resolve(r.result[0]);
          open.result.close();
        };
      };
    }),
);
const planId = stored.id;
const objects = Object.values(stored.document.objects);

function centerOf(g) {
  if (g.kind === 'rect') return [g.x + g.width / 2, g.y + g.height / 2];
  if (g.kind === 'ellipse' || g.kind === 'point') return g.kind === 'point' ? [g.x, g.y] : [g.cx, g.cy];
  const xs = g.points.map((p) => p.x);
  const ys = g.points.map((p) => p.y);
  return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
}

let worst = 0;
const rows = [];
for (const zoom of ZOOMS) {
  for (const [i, object] of objects.entries()) {
    const [cx, cy] = centerOf(object.geometry);
    await page.evaluate(
      ({ planId, cx, cy, zoom }) =>
        new Promise((resolve) => {
          const open = indexedDB.open('campplanner');
          open.onsuccess = () => {
            const tx = open.result.transaction('viewPrefs', 'readwrite');
            tx.objectStore('viewPrefs').put({ planId, centerX: cx, centerY: cy, scale: zoom });
            tx.oncomplete = () => {
              resolve();
              open.result.close();
            };
          };
        }),
      { planId, cx, cy, zoom },
    );
    await page.reload();
    await page.getByTestId('navigation-controls').waitFor({ timeout: 120_000 });
    await page.waitForFunction(
      (n) => window.Konva.stages[0]?.find('.plan-object').length === n,
      objects.length,
    );
    await page.waitForTimeout(300);
    // Écart entre le centre affiché de l'objet et sa position enregistrée projetée à l'écran.
    const shown = await page.evaluate((id) => {
      const s = window.Konva.stages[0];
      const n = s.findOne(`#${id}`);
      return {
        x: n.getAbsolutePosition().x,
        y: n.getAbsolutePosition().y,
        t: { x: s.x(), y: s.y(), scale: s.scaleX() },
      };
    }, object.id);
    const expected = [cx * shown.t.scale + shown.t.x, cy * shown.t.scale + shown.t.y];
    const error = Math.hypot(shown.x - expected[0], shown.y - expected[1]);
    worst = Math.max(worst, error);
    const file = `${outDir}/zoom-${String(zoom * 100).replace('.', '_')}-objet-${i + 1}.png`;
    await page.getByTestId('canvas-container').screenshot({ path: file });
    rows.push({
      zoom: `${zoom * 100} %`,
      objet: `${i + 1} ${object.name}`,
      'écart (px écran)': error.toFixed(4),
    });
  }
}

// La photo stockée est identique à l'original.
await page.getByRole('tab', { name: 'Fond' }).click();
await page.getByRole('button', { name: 'Vérifier l’intégrité' }).click();
await page.getByTestId('integrity-ok').waitFor();
const storedSha = await page.getByTestId('bg-sha256').textContent();
await browser.close();

console.table(rows);
console.log(`Écart maximal : ${worst.toFixed(4)} px écran`);
console.log(
  `SHA-256 original ${photoSha} · stocké ${storedSha} · ${photoSha === storedSha ? 'IDENTIQUES' : 'DIFFÉRENTS'}`,
);
if (worst > 0.5 || photoSha !== storedSha) process.exit(1);
