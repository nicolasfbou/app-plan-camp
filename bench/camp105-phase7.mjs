/**
 * Démonstration de la Phase 7 sur la VRAIE photo aérienne du Camp 105 (jamais modifiée).
 * Usage : node bench/camp105-phase7.mjs <photo> <demo-phase6.campplan> <dossier-sortie>
 * Prérequis : `npm run build && npx vite preview --port 4178` (ou APP_URL).
 *
 * Le plan reste ILLUSTRATIF : non calibré, nord non défini, aucune révision approuvée (le statut
 * « Approuvé » n'est jamais attribué par ce script). Tout passe par l'interface :
 * - import du plan de la phase 6 (format 5 → 6, vues conservées) ;
 * - Révision A (« À valider sur le terrain ») ;
 * - modifications illustratives du brouillon : zone déplacée, zone agrandie, pictogramme ajouté,
 *   trajet modifié, texte changé ;
 * - Révision B ; historique ; comparaison A ↔ B (superposition, avant / après) ; rapport de
 *   changements (PDF + Markdown) ; PDF de la révision B (plan de base et toutes les vues) ;
 * - .campplan contenant les deux révisions, réimporté dans un navigateur vide : révisions
 *   identiques, comparaison identique, SHA-256 de la photo identique.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { strFromU8, unzipSync } from 'fflate';
import { inspectPdf, layoutProblems } from './pdf-inspect.mjs';

const [photo, phase6, outDir] = process.argv.slice(2);
if (!photo || !phase6 || !outDir)
  throw new Error('Usage : node bench/camp105-phase7.mjs <photo> <demo-phase6.campplan> <dossier>');
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

async function importFile(p, path) {
  const ascii = join(tmpdir(), `camp105-p7-${Date.now()}.campplan`);
  copyFileSync(path, ascii);
  await p.getByTestId('campplan-input').setInputFiles(ascii);
  await p.getByTestId('import-verified').waitFor({ timeout: 60_000 });
  await p.getByRole('button', { name: 'Importer', exact: true }).click();
  await p.getByTestId('navigation-controls').waitFor({ timeout: 120_000 });
}
await importFile(page, phase6);

const readDocs = (p = page) =>
  p.evaluate(
    () =>
      new Promise((resolve) => {
        const open = indexedDB.open('campplanner');
        open.onsuccess = () => {
          const r = open.result.transaction('plans').objectStore('plans').getAll();
          r.onsuccess = () => {
            resolve(r.result.map((x) => x.document));
            open.result.close();
          };
        };
      }),
  );
const readRevisions = (p = page) =>
  p.evaluate(
    () =>
      new Promise((resolve) => {
        const open = indexedDB.open('campplanner');
        open.onsuccess = () => {
          const tx = open.result.transaction(['revisions', 'revisionSnapshots']);
          const metas = tx.objectStore('revisions').getAll();
          const snaps = tx.objectStore('revisionSnapshots').getAll();
          tx.oncomplete = () => {
            const json = new Map(snaps.result.map((s) => [s.id, s.json]));
            resolve(
              metas.result
                .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
                .map((r) => ({ meta: r.meta, json: json.get(r.id) })),
            );
            open.result.close();
          };
        };
      }),
  );
const waitSaved = (p = page) =>
  p
    .getByTestId('save-status')
    .filter({ hasText: /^Enregistré$/ })
    .waitFor({ timeout: 30_000 });
async function download(trigger, p = page) {
  const [d] = await Promise.all([p.waitForEvent('download', { timeout: 300_000 }), trigger()]);
  return { name: d.suggestedFilename(), bytes: readFileSync(await d.path()) };
}

let doc = (await readDocs())[0];
log('Plan importé (phase 6)', {
  nom: doc.plan.name,
  schema: doc.schemaVersion,
  vues: doc.plan.views.map((v) => v.name),
  objets: Object.keys(doc.objects).length,
  statut: doc.plan.titleBlock.status,
  nord: doc.plan.northStatus,
  calibration: doc.plan.calibration,
});

// --- Outils d'interaction (positions réelles lues dans le Stage Konva) -------------------------
const idOf = (name) => Object.values(doc.objects).find((o) => o.name === name || o.text === name).id;
async function screenOfImage(p) {
  return page.evaluate((p) => {
    const stage = window.Konva.stages[0];
    const box = stage.container().getBoundingClientRect();
    return { x: box.left + stage.x() + p.x * stage.scaleX(), y: box.top + stage.y() + p.y * stage.scaleY() };
  }, p);
}
async function nodeCenter(id) {
  return page.evaluate((id) => {
    const stage = window.Konva.stages[0];
    const box = stage.container().getBoundingClientRect();
    const r = stage.findOne(`#${id}`).getClientRect();
    return { x: box.left + r.x + r.width / 2, y: box.top + r.y + r.height / 2 };
  }, id);
}
async function select(id) {
  await page.keyboard.press('v');
  await page.keyboard.press('Escape');
  const c = await nodeCenter(id);
  await page.mouse.click(c.x, c.y);
  await page.getByRole('tab', { name: 'Propriétés' }).click();
}
async function setNumber(label, value) {
  const field = page.getByTestId('right-panel').getByRole('textbox', { name: label, exact: true }).first();
  await field.fill(String(value));
  await field.press('Enter');
}
async function openRevisions() {
  await page.getByRole('tab', { name: 'Révisions' }).click();
  await page.getByTestId('revisions-panel').waitFor();
}
async function createRevision(label, description, reason, statusLabel) {
  await openRevisions();
  await page.getByTestId('create-revision').click();
  const dialog = page.getByTestId('create-revision-dialog');
  await dialog.getByLabel('Numéro ou lettre').fill(label);
  await dialog.getByLabel('Description').fill(description);
  await dialog.getByLabel('Auteur').fill('Équipe planification (démo)');
  await dialog.getByLabel('Raison du changement').fill(reason);
  await dialog.getByLabel('Statut').selectOption({ label: statusLabel });
  await dialog.getByLabel('Commentaires').fill('Plan illustratif : positions à valider sur le terrain.');
  const t0 = Date.now();
  await page.getByTestId('confirm-create-revision').click();
  await dialog.waitFor({ state: 'hidden' });
  await waitSaved();
  return Date.now() - t0;
}

// --- 1. Révision A ------------------------------------------------------------------------------
const tA = await createRevision(
  'A',
  'Émission pour validation terrain (exemple)',
  'Première émission illustrative du plan de circulation',
  'À valider sur le terrain',
);
log('Révision A figée', { ms: tA });

// --- 2. Modifications illustratives du brouillon ------------------------------------------------
// a) Point de rassemblement déplacé (X +160 px image).
const assembly = idOf('Point de rassemblement (exemple)');
await select(assembly);
await setNumber('X', 2310);
// b) Débarquement des marchandises agrandi (largeur 260 → 330 px image).
const dropoff = idOf('Débarquement des marchandises (exemple)');
await select(dropoff);
await setNumber('Largeur', 330);
// c) Texte changé.
const road = idOf('Route du sud (exemple)');
await select(road);
const text = page.getByTestId('right-panel').getByRole('textbox', { name: 'Texte', exact: true });
await text.fill('Route du sud — accès fournisseurs (exemple)');
await text.blur();
// d) Trajet de livraison modifié : le point du milieu est déplacé.
const delivery = idOf('Livraison — accès à la cuisine (exemple)');
await select(delivery);
await page.getByRole('button', { name: 'Modifier les points' }).click();
await page.waitForTimeout(300);
const handle = await page.evaluate(() => {
  const stage = window.Konva.stages[0];
  const box = stage.container().getBoundingClientRect();
  const handles = stage.find('.vertex-handle').map((h) => h.getClientRect());
  const r = handles[1];
  return { x: box.left + r.x + r.width / 2, y: box.top + r.y + r.height / 2 };
});
await page.mouse.move(handle.x, handle.y);
await page.mouse.down();
await page.mouse.move(handle.x + 45, handle.y + 10, { steps: 8 });
await page.mouse.up();
await page.keyboard.press('Escape');
// e) Pictogramme ajouté : aire de déchargement près du débarquement.
await page.getByRole('button', { name: 'Pictogramme', exact: true }).click();
await page.locator('[data-symbol="sign.unloading"]').click();
const at = await screenOfImage({ x: 2175, y: 1560 });
await page.mouse.click(at.x, at.y);
await page.keyboard.press('Escape');
await page.keyboard.press('Escape');
await waitSaved();
await openRevisions();
await page
  .getByTestId('draft-changes')
  .filter({ hasText: /^5 changement/ })
  .waitFor({ timeout: 15_000 });
log('Brouillon modifié', { changements: await page.getByTestId('draft-changes').innerText() });

// Comparaison A ↔ brouillon (avant de créer B).
await page.getByTestId('compare-draft').click();
const compare = page.getByTestId('compare-dialog');
await compare.getByText('Rendu en cours…').waitFor({ state: 'hidden', timeout: 60_000 });
log('Comparaison A ↔ brouillon', {
  bilan: await compare.getByTestId('compare-count').innerText(),
  resume: await compare.getByTestId('compare-summary').locator('li').allInnerTexts(),
});
await page.keyboard.press('Escape');

// --- 3. Révision B ------------------------------------------------------------------------------
const tB = await createRevision(
  'B',
  'Modification de la circulation des fournisseurs (exemple)',
  'Accès fournisseurs revu (exemple illustratif)',
  'En révision',
);
log('Révision B figée', { ms: tB });
await page.getByTestId('right-panel').screenshot({ path: join(outDir, 'camp105-phase7-historique.png') });
await page.screenshot({ path: join(outDir, 'camp105-phase7-editeur-historique.png') });

// --- 4. Comparaison A ↔ B -----------------------------------------------------------------------
await page.locator('[data-testid="revision-card"][data-label="A"]').getByRole('checkbox').check();
await page.locator('[data-testid="revision-card"][data-label="B"]').getByRole('checkbox').check();
const tc = Date.now();
await page.getByTestId('compare-selected').click();
await compare.getByText('Rendu en cours…').waitFor({ state: 'hidden', timeout: 60_000 });
const compareMs = Date.now() - tc;
const comparison = {
  bilan: await compare.getByTestId('compare-count').innerText(),
  resume: await compare.getByTestId('compare-summary').locator('li').allInnerTexts(),
  objets: await compare.getByTestId('compare-objects').locator('li').allInnerTexts(),
  automatiques: await compare.getByTestId('compare-auto').locator('li').allInnerTexts(),
  ms: compareMs,
};
log('Comparaison A ↔ B', comparison);
await page.screenshot({ path: join(outDir, 'camp105-phase7-comparaison-A-B.png') });
await compare
  .getByTestId('compare-overlay')
  .screenshot({ path: join(outDir, 'camp105-phase7-superposition-A-B.png') });
// Zoom sur le trajet modifié.
await compare.locator('[data-kind="reshaped"]').first().click();
await page.waitForTimeout(800);
await page.screenshot({ path: join(outDir, 'camp105-phase7-comparaison-zoom.png') });
await compare.getByRole('button', { name: 'Réduire' }).click();
await compare.getByRole('radio', { name: 'Avant / Après' }).click();
await compare.getByTestId('compare-slider').fill('50');
await page.waitForTimeout(500);
await page.screenshot({ path: join(outDir, 'camp105-phase7-avant-apres.png') });
const reportPdf = await download(() => compare.getByTestId('report-pdf').click());
writeFileSync(join(outDir, 'camp105-phase7-rapport-changements-A-B.pdf'), reportPdf.bytes);
const reportMd = await download(() => compare.getByTestId('report-md').click());
writeFileSync(join(outDir, 'camp105-phase7-rapport-changements-A-B.md'), reportMd.bytes);
const reportInfo = await inspectPdf(browser, reportPdf.bytes, { renderScale: 1.5 });
writeFileSync(
  join(outDir, 'camp105-phase7-rapport-page1.png'),
  Buffer.from(reportInfo.png.split(',')[1], 'base64'),
);
log('Rapport de changements', { pages: reportInfo.pages, fichier: reportPdf.name });
await page.keyboard.press('Escape');

// --- 5. PDF de la révision B ---------------------------------------------------------------------
await page
  .locator('[data-testid="revision-card"][data-label="B"]')
  .getByRole('button', { name: 'Consulter' })
  .click();
const viewer = page.getByTestId('revision-viewer');
await viewer.getByText('Rendu en cours…').waitFor({ state: 'hidden', timeout: 60_000 });
await page.screenshot({ path: join(outDir, 'camp105-phase7-revision-B-consultation.png') });
const pdfB = await download(() => viewer.getByTestId('revision-export-pdf').click());
writeFileSync(join(outDir, pdfB.name), pdfB.bytes);
const pdfAll = await download(() => viewer.getByTestId('revision-export-all').click());
writeFileSync(join(outDir, 'camp105-phase7-revision-B-toutes-les-vues.pdf'), pdfAll.bytes);
const infoB = await inspectPdf(browser, pdfB.bytes, { renderScale: 2 });
writeFileSync(
  join(outDir, 'camp105-phase7-revision-B-pdf-rendu.png'),
  Buffer.from(infoB.png.split(',')[1], 'base64'),
);
const infoAll = await inspectPdf(browser, pdfAll.bytes);
log('PDF de la révision B', {
  fichier: pdfB.name,
  formatMm: [Math.round(infoB.widthMm * 10) / 10, Math.round(infoB.heightMm * 10) / 10],
  cartouche: [
    'RÉVISION B',
    'Équipe planification (démo)',
    'En révision',
    'Rév.',
    'Émission pour validation terrain (exemple)',
  ].map((t) => [t, infoB.text.includes(t)]),
  nonApprouve: infoB.text.includes('NON APPROUVÉ'),
  // Nord non défini : cartouche « Non défini », aucune flèche (aucun « N » isolé sur la page).
  aucuneFlecheNord: infoB.text.includes('Non défini') && !infoB.texts.some((t) => t.str.trim() === 'N'),
  nonCalibre: infoB.text.includes('Plan non calibré'),
  problemesMiseEnPage: layoutProblems(infoB),
  pagesToutesVues: infoAll.pages,
});
await page.keyboard.press('Escape');

// --- 6. .campplan avec révisions, réimporté dans un navigateur vide ------------------------------
await waitSaved();
const revisionsBefore = await readRevisions();
const campplan = await download(() => page.getByRole('button', { name: 'Exporter (.campplan)' }).click());
const campplanPath = join(outDir, 'camp-105-phase7-revisions.campplan');
writeFileSync(campplanPath, campplan.bytes);
const zip = unzipSync(new Uint8Array(campplan.bytes));
const manifest = JSON.parse(strFromU8(zip['manifest.json']));
log('.campplan', {
  format: manifest.formatVersion,
  schema: manifest.schemaVersion,
  revisions: manifest.revisions.map((r) => `${r.meta.label} (${r.meta.status})`),
  fichiers: manifest.files.map((f) => `${f.role} ${f.sha256.slice(0, 12)}…`),
  photoUneSeuleFois: manifest.files.filter((f) => f.role === 'background').length === 1,
  photoIdentique: manifest.files.some((f) => f.sha256 === photoSha),
  octets: campplan.bytes.length,
});

const fresh = await (await browser.newContext({ viewport: { width: 1600, height: 1000 } })).newPage();
await fresh.goto(APP);
await importFile(fresh, campplanPath);
const revisionsAfter = await readRevisions(fresh);
await fresh.getByRole('tab', { name: 'Révisions' }).click();
await fresh.locator('[data-testid="revision-card"][data-label="A"]').getByRole('checkbox').check();
await fresh.locator('[data-testid="revision-card"][data-label="B"]').getByRole('checkbox').check();
await fresh.getByTestId('compare-selected').click();
const freshCount = await fresh.getByTestId('compare-count').innerText();
await fresh.keyboard.press('Escape');
await fresh.getByRole('tab', { name: 'Fond' }).click();
log('Réimport dans un navigateur vide', {
  revisionsIdentiques:
    JSON.stringify(revisionsAfter.map((r) => r.json)) === JSON.stringify(revisionsBefore.map((r) => r.json)),
  empreintes: revisionsAfter.map((r) => `${r.meta.label} ${r.meta.snapshot.sha256.slice(0, 16)}…`),
  comparaisonIdentique: freshCount === comparison.bilan,
  photoSha256: await fresh.getByTestId('bg-sha256').innerText(),
});

doc = (await readDocs())[0];
report.integrity = {
  photoSourceInchangee: sha(readFileSync(photo)) === photoSha,
  statutBrouillon: doc.plan.titleBlock.status,
  revisions: revisionsBefore.map((r) => ({
    label: r.meta.label,
    statut: r.meta.status,
    approbation: r.meta.approval,
  })),
  nord: doc.plan.northStatus,
  calibration: doc.plan.calibration,
  erreursDePage: errors,
};
log('Intégrité', report.integrity);
writeFileSync(join(outDir, 'camp105-phase7-rapport.json'), JSON.stringify(report, null, 2));
await browser.close();
