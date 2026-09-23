/**
 * Performance des révisions dans le navigateur (interface réelle) :
 *   node bench/revisions-browser-perf.mjs <plan.campplan> [sortie.json]
 * Import du fichier, affichage de l'historique, consultation d'une révision, comparaison de la
 * première et de la dernière révision (rendu compris), mémoire JS utilisée.
 */
import { copyFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const [file, out] = process.argv.slice(2);
const APP = process.env.APP_URL ?? 'http://localhost:4178/';
const browser = await chromium.launch({
  executablePath: process.env.PW_CHROMIUM_PATH ?? '/opt/pw-browsers/chromium',
});
const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 } })).newPage();
await page.goto(APP);
const ascii = join(tmpdir(), `perf-${Date.now()}.campplan`);
copyFileSync(file, ascii);
const time = async (fn) => {
  const t0 = Date.now();
  await fn();
  return Date.now() - t0;
};
const heap = () => page.evaluate(() => Math.round((performance.memory?.usedJSHeapSize ?? 0) / 1e6));
const r = {};
r.importMs = await time(async () => {
  await page.getByTestId('campplan-input').setInputFiles(ascii);
  await page.getByTestId('import-verified').waitFor({ timeout: 120_000 });
  await page.getByRole('button', { name: 'Importer', exact: true }).click();
  await page.getByTestId('plan-title').waitFor();
});
await page.waitForTimeout(1000);
r.heapApresOuvertureMo = await heap();
r.historiqueMs = await time(async () => {
  await page.getByRole('tab', { name: 'Révisions' }).click();
  await page.getByTestId('revision-card').first().waitFor();
  await page
    .getByTestId('draft-changes')
    .filter({ hasText: /changement/ })
    .waitFor({ timeout: 60_000 });
});
r.revisionsAffichees = await page.getByTestId('revision-card').count();
r.heapApresHistoriqueMo = await heap();
const cards = page.getByTestId('revision-card');
r.consultationMs = await time(async () => {
  await cards.first().getByRole('button', { name: 'Consulter' }).click();
  await page
    .getByTestId('revision-viewer')
    .getByText('Rendu en cours…')
    .waitFor({ state: 'hidden', timeout: 60_000 });
});
await page.keyboard.press('Escape');
await cards.first().getByRole('checkbox').check();
await cards.last().getByRole('checkbox').check();
r.comparaisonMs = await time(async () => {
  await page.getByTestId('compare-selected').click();
  await page.getByTestId('compare-count').waitFor();
  await page
    .getByTestId('compare-dialog')
    .getByText('Rendu en cours…')
    .waitFor({ state: 'hidden', timeout: 60_000 });
});
r.bilan = await page.getByTestId('compare-count').innerText();
r.heapApresComparaisonMo = await heap();
console.log(JSON.stringify(r, null, 2));
if (out) writeFileSync(out, JSON.stringify(r, null, 2));
await browser.close();
