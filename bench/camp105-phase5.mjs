/**
 * Démonstration de la Phase 5 sur la VRAIE photo aérienne du Camp 105 (jamais modifiée).
 * Usage : node bench/camp105-phase5.mjs <photo> <demo-phase4.campplan> <dossier-sortie>
 * Prérequis : `npm run build && npx vite preview --port 4178` (ou APP_URL).
 *
 * AVERTISSEMENTS (reportés dans le cartouche du plan) :
 * - disposition ILLUSTRATIVE, à valider sur le terrain : ce n'est pas un plan approuvé ;
 * - plan NON calibré : aucune distance réelle connue et vérifiable n'est disponible, donc aucune
 *   calibration n'est ajoutée ; les mesures restent en pixels et aucune échelle n'est imprimée ;
 * - la photo ne contient aucune donnée d'orientation (pas de cap de drone) : la flèche du nord est
 *   une flèche de DÉMONSTRATION à angle arbitraire, marquée « estimé — à vérifier ».
 *
 * Tout passe par l'interface : réimport du plan de la phase 4 (trajets, corridors, zones,
 * pictogrammes, étiquettes), génération de cases, cote, nord, cartouche, légende ; aperçu ;
 * export PDF Tabloïd 11 × 17 paysage, PNG haute résolution, JPG ; .campplan exporté puis réimporté.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { chromium } from '@playwright/test';
import { unzipSync, strFromU8 } from 'fflate';
import { inspectPdf } from './pdf-inspect.mjs';

const [photo, phase4, outDir] = process.argv.slice(2);
if (!photo || !phase4 || !outDir)
  throw new Error('Usage : node bench/camp105-phase5.mjs <photo> <demo-phase4.campplan> <dossier>');
const APP = process.env.APP_URL ?? 'http://localhost:4178/';
mkdirSync(outDir, { recursive: true });
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const photoSha = sha(readFileSync(photo));
const report = { photoSha256: photoSha, steps: [] };
const log = (step, data = {}) => {
  report.steps.push({ step, ...data });
  console.log(step, JSON.stringify(data));
};

const browser = await chromium.launch({
  executablePath: process.env.PW_CHROMIUM_PATH ?? '/opt/pw-browsers/chromium',
});
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, acceptDownloads: true });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(APP);

// 1. Plan de la phase 4 réimporté (chemin ASCII : Chromium ignore les chemins accentués).
const ascii = join(tmpdir(), `camp105-p5-${Date.now()}.campplan`);
copyFileSync(phase4, ascii);
await page.getByTestId('campplan-input').setInputFiles(ascii);
await page.getByTestId('import-verified').waitFor({ timeout: 60_000 });
await page.getByRole('button', { name: 'Importer', exact: true }).click();
await page.getByTestId('navigation-controls').waitFor({ timeout: 120_000 });

const readStored = (p) =>
  p.evaluate(
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
const waitSaved = () =>
  page
    .getByTestId('save-status')
    .filter({ hasText: /^Enregistré$/ })
    .waitFor({ timeout: 30_000 });
async function setView(planId, cx, cy, zoom) {
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
}
const planId = (await readStored(page)).id;
await setView(planId, 1800, 1300, 0.5);
const box = await page.getByTestId('canvas-container').boundingBox();
const toScreen = async ([x, y]) => {
  const t = await page.evaluate(() => {
    const s = window.Konva.stages[0];
    return { x: s.x(), y: s.y(), scale: s.scaleX() };
  });
  return [box.x + x * t.scale + t.x, box.y + y * t.scale + t.y];
};
async function setField(label, value) {
  const field = page.getByLabel(label, { exact: true });
  await field.fill(String(value));
  await field.press('Enter');
  await field.blur();
}

// 2. Cases de stationnement générées dans la zone « Stationnement employés » (rangée de véhicules
//    garés visible sur la photo). Plan non calibré : dimensions en pixels de la photo.
await page.getByRole('tab', { name: 'Calques' }).click();
await page.getByRole('button', { name: 'Stationnement employés (exemple)', exact: true }).click();
await page.getByRole('tab', { name: 'Propriétés' }).click();
await setField('Largeur de case (px)', 30);
await setField('Longueur de case (px)', 80);
await setField('Rangées', 1);
await setField('Orientation des rangées (°)', 90);
await page.getByRole('button', { name: 'Générer les cases' }).click();
const stallText = await page.getByTestId('stall-count').textContent();
log('Cases générées', { texte: stallText });
await page.keyboard.press('Escape');
await waitSaved();

// 3. Cote (outil Mesurer) le long de la zone de stationnement : en pixels (plan non calibré).
await page.keyboard.press('m');
await page.mouse.click(...(await toScreen([1690, 1080])));
await page.mouse.click(...(await toScreen([1690, 1410])));
await page.keyboard.press('Enter');
await page.keyboard.press('Escape');
await waitSaved();

// 4. Nord : AUCUNE donnée d'orientation dans la photo. Flèche de démonstration « estimée — à
//    vérifier », angle arbitraire (volontairement différent de 0 : le haut de l'image n'est pas
//    présumé être le nord).
await page.getByRole('tab', { name: 'Fond' }).click();
await page.getByRole('button', { name: 'Orienter le nord (2 points)' }).click();
await page.mouse.click(...(await toScreen([2600, 700])));
await page.mouse.click(...(await toScreen([2680, 400])));
await waitSaved();
log('Nord', { statut: await page.getByTestId('north-status').textContent() });
log('Calibration', { statut: await page.getByTestId('calibration-status').textContent() });

// 5. Mise en page : cartouche, légende, Tabloïd 11 × 17 paysage.
await page.getByTestId('open-print').click();
await page.getByTestId('print-dialog').waitFor();
const settings = page.getByTestId('print-settings');
await settings.getByRole('combobox', { name: 'Format', exact: true }).selectOption('tabloid');
await settings.getByRole('combobox', { name: 'Orientation', exact: true }).selectOption('landscape');
const fields = {
  'Nom du camp': 'Camp 105',
  'Titre du plan': 'Plan de circulation — EXEMPLE ILLUSTRATIF',
  'Préparé par': 'CampPlanner — démonstration Phase 5',
  'Numéro de plan': 'CP105-DEMO-P5',
  Révision: 'A',
};
for (const [label, value] of Object.entries(fields))
  await settings.getByRole('textbox', { name: label, exact: true }).fill(value);
await settings
  .getByRole('textbox', { name: 'Notes', exact: true })
  .fill(
    'EXEMPLE ILLUSTRATIF : disposition non validée, à valider sur le terrain. Plan NON calibré : aucune échelle, mesures en pixels de la photo. Flèche du nord de démonstration (angle arbitraire) : orientation réelle à déterminer.',
  );
await settings.getByRole('combobox', { name: 'Statut', exact: true }).selectOption('field-validation');
await page.waitForTimeout(1500);
await page.getByTestId('print-preview').evaluate(() => new Promise((r) => setTimeout(r, 500)));
await page.screenshot({ path: join(outDir, 'camp105-phase5-apercu.png') });
const warnings = await page.locator('[data-warning]').allInnerTexts();
log('Aperçu : avertissements', { warnings });

async function exportAs(format, name, prepare) {
  await page.getByRole('radio', { name: format }).click();
  if (prepare) await prepare();
  await page.waitForTimeout(800);
  const t0 = Date.now();
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 300_000 }),
    page.getByTestId('print-export').click(),
  ]);
  const path = join(outDir, name);
  await download.saveAs(path);
  return { path, ms: Date.now() - t0, bytes: readFileSync(path).length };
}
const pdf = await exportAs('PDF', 'camp105-phase5-tabloid-paysage.pdf');
const pdfInfo = await inspectPdf(browser, readFileSync(pdf.path), { renderScale: 2 });
writeFileSync(join(outDir, 'camp105-phase5-pdf-rendu.png'), Buffer.from(pdfInfo.png.split(',')[1], 'base64'));
log('PDF', {
  ...pdf,
  pages: pdfInfo.pages,
  formatMm: [Math.round(pdfInfo.widthMm * 10) / 10, Math.round(pdfInfo.heightMm * 10) / 10],
  polices: pdfInfo.fonts,
  images: pdfInfo.operators.paintImageXObject ?? 0,
  cheminsVectoriels: pdfInfo.operators.constructPath ?? 0,
  textes: pdfInfo.operators.showText ?? 0,
  contientNonCalibre: pdfInfo.text.includes('non calibré'),
  contientIllustratif: /EXEMPLE ILLUSTRATIF/.test(pdfInfo.text),
  contientNordAVerifier: pdfInfo.text.includes('à vérifier'),
});
const png = await exportAs('PNG', 'camp105-phase5-haute-resolution.png', async () => {
  await settings.getByLabel('Cadrage de l’image', { exact: true }).selectOption('image');
});
log('PNG', { ...png, dimensions: await page.getByTestId('raster-size').textContent() });
const jpg = await exportAs('JPG', 'camp105-phase5-page.jpg', async () => {
  await settings.getByLabel('Cadrage de l’image', { exact: true }).selectOption('page');
});
log('JPG', jpg);
await page.getByRole('button', { name: 'Fermer' }).first().click();
await waitSaved();

// 6. Export .campplan, puis réimport dans un navigateur au stockage vide.
const before = (await readStored(page)).document;
const [campplan] = await Promise.all([
  page.waitForEvent('download'),
  page.getByRole('button', { name: 'Exporter (.campplan)' }).click(),
]);
const archive = join(outDir, 'camp-105-phase5-demo.campplan');
await campplan.saveAs(archive);
const files = unzipSync(new Uint8Array(readFileSync(archive)));
const manifest = JSON.parse(strFromU8(files['manifest.json']));
const photoEntry = manifest.files.find((f) => f.role === 'background');
log('.campplan', {
  octets: readFileSync(archive).length,
  schema: manifest.schemaVersion,
  photoIdentique: photoEntry?.sha256 === photoSha,
});

const asciiCopy = join(tmpdir(), `camp105-p5-re-${Date.now()}.campplan`);
copyFileSync(archive, asciiCopy);
const context2 = await browser.newContext({ viewport: { width: 1600, height: 1000 }, acceptDownloads: true });
const fresh = await context2.newPage();
await fresh.goto(APP);
await fresh.getByTestId('campplan-input').setInputFiles(asciiCopy);
await fresh.getByTestId('import-verified').waitFor({ timeout: 60_000 });
await fresh.getByRole('button', { name: 'Importer', exact: true }).click();
await fresh.getByTestId('navigation-controls').waitFor({ timeout: 120_000 });
const imported = (await readStored(fresh)).document;
const same = ['objects', 'layers', 'crossingReviews'].every((k) => isDeepStrictEqual(imported[k], before[k]));
const sameSettings = [
  'legend',
  'titleBlock',
  'print',
  'northStatus',
  'northAngleDeg',
  'calibration',
  'units',
].every((k) => isDeepStrictEqual(imported.plan[k], before.plan[k]));
await fresh.getByRole('tab', { name: 'Fond' }).click();
const [original] = await Promise.all([
  fresh.waitForEvent('download'),
  fresh.getByRole('button', { name: 'Télécharger l’original' }).click(),
]);
const originalSha = sha(readFileSync(await original.path()));
log('Réimport', {
  objetsIdentiques: same,
  reglagesIdentiques: sameSettings,
  photoOriginaleIdentique: originalSha === photoSha,
  statut: imported.plan.titleBlock.status,
  approuve: imported.plan.titleBlock.status === 'approved',
});
log('Photo source inchangée', { identique: sha(readFileSync(photo)) === photoSha });
report.errors = errors;
writeFileSync(join(outDir, 'camp105-phase5-rapport.json'), JSON.stringify(report, null, 2));
console.log('Erreurs de page :', errors);
await browser.close();
