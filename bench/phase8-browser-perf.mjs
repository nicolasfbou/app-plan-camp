/**
 * Performance et mémoire (Phase 8), interface réelle dans Chromium :
 *   node bench/phase8-browser-perf.mjs <dossier-sortie>
 * 1. Fabrique une image d'ESSAI synthétique de 50 MP (bruit + dégradés ; ce n'est PAS une photo
 *    du camp, seulement une charge de test) ;
 * 2. génère avec elle un `.campplan` (1 000 objets, 4 vues, 3 pictogrammes importés, 20 révisions)
 *    via `src/diagnostics/phase8.perf.test.ts` ;
 * 3. navigateur vide : import, ouverture, santé, diagnostic ; puis boucles de fuite mémoire
 *    (ouvrir / fermer 20 fois, comparer des révisions, exporter des PDF, importer / supprimer des
 *    projets) avec mesure du tas JS après ramasse-miettes forcé.
 * Serveur attendu : `npx vite preview --port 4178` (APP_URL pour changer).
 */
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const out = resolve(process.argv[2] ?? 'local-test-data/phase8/perf');
mkdirSync(out, { recursive: true });
const APP = process.env.APP_URL ?? 'http://localhost:4178/';
const W = 8660;
const H = 5774;
const browser = await chromium.launch({
  executablePath: process.env.PW_CHROMIUM_PATH ?? '/opt/pw-browsers/chromium',
  args: ['--js-flags=--expose-gc', '--enable-precise-memory-info'],
});

// 1. Image d'essai de 50 MP.
const photo = join(out, 'image-essai-50mp.jpg');
if (!existsSync(photo)) {
  const page = await browser.newPage();
  await page.goto(APP);
  const bytes = await page.evaluate(
    async ({ W, H }) => {
      const canvas = new OffscreenCanvas(W, H);
      const c = canvas.getContext('2d');
      const g = c.createLinearGradient(0, 0, W, H);
      g.addColorStop(0, '#5b7a3a');
      g.addColorStop(0.5, '#a39a78');
      g.addColorStop(1, '#3d5a6b');
      c.fillStyle = g;
      c.fillRect(0, 0, W, H);
      const tile = new ImageData(512, 512);
      for (let i = 0; i < tile.data.length; i += 4) {
        const v = Math.random() * 90;
        tile.data.set([v, v, v, 70], i);
      }
      const t = new OffscreenCanvas(512, 512);
      t.getContext('2d').putImageData(tile, 0, 0);
      for (let y = 0; y < H; y += 512) for (let x = 0; x < W; x += 512) c.drawImage(t, x, y);
      c.fillStyle = 'rgba(255,255,255,0.8)';
      c.font = 'bold 400px sans-serif';
      c.fillText('IMAGE D’ESSAI 50 MP', 400, 800);
      const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
      return [...new Uint8Array(await blob.arrayBuffer())];
    },
    { W, H },
  );
  writeFileSync(photo, Buffer.from(bytes));
  await page.close();
}

// 2. Projet volumineux.
const campplan = join(out, 'perf-50mp-1000-objets-20-revisions.campplan');
execSync('npx vitest run src/diagnostics/phase8.perf.test.ts', {
  stdio: 'inherit',
  env: {
    ...process.env,
    PERF: '1',
    PERF_PHOTO: photo,
    PERF_PHOTO_W: String(W),
    PERF_PHOTO_H: String(H),
    PERF_OUT: out,
  },
});

// 3. Navigateur vide.
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, acceptDownloads: true });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(APP);
const time = async (fn) => {
  const t0 = Date.now();
  await fn();
  return Date.now() - t0;
};
const heap = async () => {
  await page.evaluate(() => window.gc?.());
  await page.waitForTimeout(300);
  await page.evaluate(() => window.gc?.());
  return page.evaluate(() => Math.round((performance.memory?.usedJSHeapSize ?? 0) / 1e5) / 10);
};
const background = () => page.getByTestId('navigation-controls').waitFor({ timeout: 120_000 });
const importProject = async () => {
  await page.goto(`${APP}#/`);
  await page.getByTestId('campplan-input').setInputFiles(campplan);
  await page.getByTestId('import-verified').waitFor({ timeout: 180_000 });
  await page.getByRole('button', { name: 'Importer', exact: true }).click();
  await background();
};
const r = { image: { largeur: W, hauteur: H, megapixels: (W * H) / 1e6 } };
const save = () => writeFileSync(join(out, 'perf-navigateur-phase8.json'), JSON.stringify(r, null, 2));
const fail = async (e) => {
  r.erreur = String(e);
  save();
  await page.screenshot({ path: join(out, 'perf-erreur.png') }).catch(() => undefined);
  process.exit(1);
};
process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);
r.heapInitialMo = await heap();
r.importEtOuvertureMs = await time(importProject);
const planUrl = page.url();
const campUrl = planUrl.replace(/\/plan\/.*$/, '');
r.heapApresOuvertureMo = await heap();
r.objetsAffiches = await page.evaluate(() => {
  const stage = window.Konva?.stages?.[0];
  return stage ? stage.find('Shape').length : null;
});

r.santeMs = await time(async () => {
  await page.getByRole('button', { name: 'Santé et sauvegardes' }).click();
  await page.getByTestId('health-overall').waitFor({ timeout: 120_000 });
  await page.getByTestId('health-checks').locator('[data-check="photo-sha"]').waitFor();
});
r.santeGlobale = await page.getByTestId('health-overall').getAttribute('data-status');
r.santeControles = Object.fromEntries(
  await page
    .getByTestId('health-checks')
    .locator('[data-check]')
    .evaluateAll((els) => els.map((e) => [e.getAttribute('data-check'), e.getAttribute('data-status')])),
);
await page.keyboard.press('Escape');

// Ouvrir / fermer le plan 20 fois.
const openClose = [];
const heapOpenClose = [];
for (let i = 0; i < 20; i++) {
  await page.goto(campUrl);
  await page.getByText('Plan perf').first().waitFor();
  openClose.push(
    await time(async () => {
      await page.goto(planUrl);
      await background();
    }),
  );
  if (i % 5 === 4) heapOpenClose.push(await heap());
}
r.ouvertureMsMin = Math.min(...openClose);
r.ouvertureMsMax = Math.max(...openClose);
r.ouvertureMsMediane = openClose.sort((a, b) => a - b)[10];
r.heapOuvrirFermerx20Mo = heapOpenClose;
save();

// Comparer des révisions (5 fois).
const heapCompare = [];
const compareMs = [];
await page.getByRole('tab', { name: 'Révisions' }).click();
const cards = page.getByTestId('revision-card');
await cards.first().waitFor();
r.revisions = await cards.count();
for (let i = 0; i < 5; i++) {
  await cards.nth(i).getByRole('checkbox').check();
  await cards
    .nth(19 - i)
    .getByRole('checkbox')
    .check();
  compareMs.push(
    await time(async () => {
      await page.getByTestId('compare-selected').click();
      await page.getByTestId('compare-count').waitFor();
      await page
        .getByTestId('compare-dialog')
        .getByText('Rendu en cours…')
        .waitFor({ state: 'hidden', timeout: 120_000 });
    }),
  );
  await page.keyboard.press('Escape');
  await page.getByTestId('compare-dialog').waitFor({ state: 'hidden' });
  await cards.nth(i).getByRole('checkbox').uncheck();
  await cards
    .nth(19 - i)
    .getByRole('checkbox')
    .uncheck();
  heapCompare.push(await heap());
}
r.comparaisonMs = compareMs;
r.heapComparaisonsMo = heapCompare;
save();

// Exporter plusieurs PDF (3).
const pdfMs = [];
const heapPdf = [];
for (let i = 0; i < 3; i++) {
  await page.getByTestId('open-print').click();
  await page.getByTestId('print-dialog').waitFor();
  pdfMs.push(
    await time(async () => {
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 180_000 }),
        page.getByTestId('print-export').click(),
      ]);
      await download.path();
    }),
  );
  await page.keyboard.press('Escape');
  await page.getByTestId('print-dialog').waitFor({ state: 'hidden' });
  heapPdf.push(await heap());
}
r.exportPdfMs = pdfMs;
r.heapExportsPdfMo = heapPdf;
save();

// Importer puis supprimer des projets (3).
const heapImport = [];
for (let i = 0; i < 3; i++) {
  await importProject();
  const url = page.url().replace(/\/plan\/.*$/, '');
  await page.goto(url);
  const del = page.getByRole('button', { name: /^Supprimer (le plan )?Plan perf/ }).first();
  await del.click();
  const dialog = page.getByRole('dialog');
  const confirmName = dialog.getByRole('textbox');
  if (await confirmName.count()) await confirmName.fill('Plan perf');
  await dialog.getByRole('button', { name: 'Supprimer' }).click();
  await dialog.waitFor({ state: 'hidden' });
  heapImport.push(await heap());
}
r.heapImporterSupprimerMo = heapImport;
r.stockage = await page.evaluate(async () => {
  const e = await navigator.storage.estimate();
  return { usageMo: Math.round(e.usage / 1e5) / 10, quotaMo: Math.round(e.quota / 1e5) / 10 };
});
r.erreursPage = errors;
console.log(JSON.stringify(r, null, 2));
writeFileSync(join(out, 'perf-navigateur-phase8.json'), JSON.stringify(r, null, 2));
await browser.close();
