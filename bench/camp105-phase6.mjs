/**
 * Démonstration de la Phase 6 sur la VRAIE photo aérienne du Camp 105 (jamais modifiée).
 * Usage : node bench/camp105-phase6.mjs <photo> <demo-phase5.campplan> <dossier-sortie>
 * Prérequis : `npm run build && npx vite preview --port 4178` (ou APP_URL).
 *
 * Le plan reste celui de la phase 5 : ILLUSTRATIF, NON calibré, nord NON défini, statut « À valider
 * sur le terrain — NON APPROUVÉ ». Tout passe par l'interface :
 * - vues par public (Employés, Fournisseurs, Direction, Sécurité / urgence) avec leurs styles ;
 * - analyse de lisibilité de chaque vue (rapport) ;
 * - captures de la mise en page des vues Employés, Fournisseurs et Direction ;
 * - export groupé : un PDF par public (.zip) et un PDF multi-pages ;
 * - modèles d'entreprise « Modèle PAMM — général / circulation / fournisseur / employés » créés sur
 *   un plan-gabarit vierge (sans photo ni objet), exportés en .campmodele ;
 * - variante hiver du plan (copie indépendante) ;
 * - SHA-256 de la photo d'origine vérifié à la fin.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { strFromU8, unzipSync } from 'fflate';
import { inspectPdf, layoutProblems } from './pdf-inspect.mjs';

const [photo, phase5, outDir] = process.argv.slice(2);
if (!photo || !phase5 || !outDir)
  throw new Error('Usage : node bench/camp105-phase6.mjs <photo> <demo-phase5.campplan> <dossier>');
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

const ascii = join(tmpdir(), `camp105-p6-${Date.now()}.campplan`);
copyFileSync(phase5, ascii);
await page.getByTestId('campplan-input').setInputFiles(ascii);
await page.getByTestId('import-verified').waitFor({ timeout: 60_000 });
await page.getByRole('button', { name: 'Importer', exact: true }).click();
await page.getByTestId('navigation-controls').waitFor({ timeout: 120_000 });

const readDocs = () =>
  page.evaluate(
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
const waitSaved = () =>
  page
    .getByTestId('save-status')
    .filter({ hasText: /^Enregistré$/ })
    .waitFor({ timeout: 30_000 });
const demoName = (await readDocs())[0].plan.name;
const baseline = JSON.stringify((await readDocs())[0].objects);

async function download(trigger) {
  const [d] = await Promise.all([page.waitForEvent('download', { timeout: 300_000 }), trigger()]);
  return { name: d.suggestedFilename(), bytes: readFileSync(await d.path()) };
}

// 1. Vues par public, créées dans la mise en page (styles proposés pour chaque public).
await page.getByTestId('open-print').click();
await page.getByTestId('print-dialog').waitFor();
for (const audience of ['employees', 'suppliers', 'management', 'safety']) {
  await page.getByTestId('view-add').click();
  await page.locator(`[data-audience="${audience}"]`).click();
  await page.waitForTimeout(300);
}
await page.getByRole('button', { name: 'Fermer' }).first().click();
await waitSaved();
let doc = (await readDocs())[0];
log('Vues créées', {
  vues: doc.plan.views.map((v) => ({ nom: v.name, style: v.print.style.preset, detail: v.print.detail })),
  objetsInchanges: JSON.stringify(doc.objects) === baseline,
});

// 2. Lisibilité de chaque vue (même analyse que les PDF) : AVANT corrections.
await page.getByRole('tab', { name: 'Analyse' }).click();
const viewSelect = page.getByTestId('view-select');
const VIEWS = ['Plan de base (tout)', 'Employés', 'Fournisseurs', 'Direction', 'Sécurité / urgence'];
async function analyse() {
  const rows = [];
  for (const name of VIEWS) {
    await viewSelect.selectOption({ label: name });
    await page.waitForTimeout(900);
    await page.getByTestId('readability-count').waitFor();
    const count = await page.getByTestId('readability-count').innerText();
    const items = await page.getByTestId('readability-list').locator('li').allInnerTexts();
    rows.push({ vue: name, bilan: count, problemes: items.map((t) => t.split('\n')[1] ?? t) });
  }
  return rows;
}
const readabilityBefore = await analyse();
log('Lisibilité par vue (avant)', { readabilityBefore });

// Corrections, comme un utilisateur : rien n'est déplacé sans validation.
// a) Vue Employés : l'étiquette « Route du sud » touche la limite de vitesse agrandie →
//    emplacement PROPOSÉ, puis ACCEPTÉ.
await viewSelect.selectOption({ label: 'Employés' });
await page.waitForTimeout(900);
const textIcon = page.locator('[data-issue-kind="text-icon"]').first();
await textIcon.getByTestId('propose').click();
await page.getByTestId('label-proposal').waitFor();
await page.waitForTimeout(400);
await page.screenshot({ path: join(outDir, 'camp105-phase6-proposition-etiquette.png') });
await page.getByTestId('proposal-accept').click();
await waitSaved();
// b) Vue Fournisseurs : pictogrammes un peu moins agrandis (réglage du style de la vue).
await viewSelect.selectOption({ label: 'Fournisseurs' });
await page.getByTestId('open-print').click();
await page.getByTestId('print-dialog').waitFor();
await page.getByTestId('style-iconScale').fill('1.1');
await page.getByRole('button', { name: 'Fermer' }).first().click();
await waitSaved();
await page.getByRole('tab', { name: 'Analyse' }).click();
const readability = await analyse();
log('Lisibilité par vue (après)', { readability });

const slugs = { Employés: 'employes', Fournisseurs: 'fournisseurs', Direction: 'direction' };
for (const name of Object.keys(slugs)) {
  await viewSelect.selectOption({ label: name });
  await page.getByTestId('open-print').click();
  await page.getByTestId('print-dialog').waitFor();
  await page.waitForTimeout(3000);
  await page.screenshot({ path: join(outDir, `camp105-phase6-vue-${slugs[name]}.png`) });
  await page.getByRole('button', { name: 'Fermer' }).first().click();
}
await viewSelect.selectOption({ label: 'Plan de base (tout)' });

// 3. Export groupé : un PDF par public (archive .zip), puis un PDF multi-pages.
await page.getByTestId('open-print').click();
await page.getByTestId('print-dialog').waitFor();
await page.getByTestId('open-batch').click();
const zip = await download(() => page.getByTestId('batch-export').click());
const pdfs = unzipSync(new Uint8Array(zip.bytes));
const pdfChecks = [];
for (const [file, bytes] of Object.entries(pdfs)) {
  writeFileSync(join(outDir, file), bytes);
  const info = await inspectPdf(browser, Buffer.from(bytes));
  const problems = layoutProblems(info);
  pdfChecks.push({
    fichier: file,
    pages: info.pages,
    formatMm: [Math.round(info.widthMm * 10) / 10, Math.round(info.heightMm * 10) / 10],
    chevauchements: problems.overlaps.length,
    horsPage: problems.outside.length,
    plusPetitTextePt: Math.round(problems.minTextPt * 10) / 10,
    nonApprouve: info.text.includes('NON APPROUVÉ'),
    nonCalibre: info.text.includes('non calibré'),
    aucuneFlecheNord: !info.text.includes('Nord estimé'),
  });
}
log('PDF par public', { pdfChecks });
await page.getByTestId('batch-dialog').getByLabel('Un seul PDF, une page par vue').check();
const combined = await download(() => page.getByTestId('batch-export').click());
writeFileSync(join(outDir, 'camp105-phase6-toutes-les-vues.pdf'), combined.bytes);
const combinedInfo = await inspectPdf(browser, combined.bytes);
log('PDF multi-pages', { pages: combinedInfo.pages, octets: combined.bytes.length });
await page.keyboard.press('Escape');
await page.getByRole('button', { name: 'Fermer' }).first().click();

// 4. Export .campplan du plan avec ses vues.
await waitSaved();
const campplan = await download(() => page.getByRole('button', { name: 'Exporter (.campplan)' }).click());
writeFileSync(join(outDir, 'camp-105-phase6-demo.campplan'), campplan.bytes);
const manifest = JSON.parse(strFromU8(unzipSync(new Uint8Array(campplan.bytes))['manifest.json']));
log('.campplan', {
  schema: manifest.schemaVersion,
  photoIdentique: manifest.files.find((f) => f.role === 'background')?.sha256 === photoSha,
});

// 5. Variante hiver (copie indépendante).
await page.getByRole('button', { name: 'Variante de ce plan (été / hiver…)' }).click();
await page.getByTestId('variant-dialog').getByLabel('Nom de la variante').fill(`${demoName} — hiver`);
await page.getByTestId('variant-kind').selectOption('winter-circulation');
await page.getByTestId('variant-create').click();
await page.getByTestId('navigation-controls').waitFor({ timeout: 120_000 });
let docs = await readDocs();
const winter = docs.find((d) => d.plan.name === `${demoName} — hiver`);
log('Variante hiver', {
  type: winter.plan.kind,
  origine: winter.plan.variantOf?.planName,
  objetsCopies: Object.keys(winter.objects).length,
  statut: winter.plan.titleBlock.status,
});

// 6. Modèles PAMM : créés sur un plan-gabarit VIERGE (aucune photo, aucun objet).
await page.getByRole('link', { name: 'Camp 105' }).click();
await page.getByRole('button', { name: 'Nouveau plan' }).click();
await page.getByLabel('Nom du plan').fill('Gabarit PAMM');
await page.getByRole('button', { name: 'Créer', exact: true }).click();
await page.getByTestId('plan-title').filter({ hasText: 'Gabarit PAMM' }).waitFor();
await page.getByTestId('open-print').click();
await page.getByTestId('print-dialog').waitFor();
const settings = page.getByTestId('print-settings');
await settings.getByRole('textbox', { name: 'Entreprise', exact: true }).fill('PAMM');
await settings.getByRole('combobox', { name: 'Format', exact: true }).selectOption('tabloid');
async function addView(audience) {
  await page.getByTestId('view-add').click();
  await page.locator(`[data-audience="${audience}"]`).click();
  await page.waitForTimeout(200);
}
async function deleteCurrentView() {
  await page.getByRole('button', { name: 'Supprimer la vue', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Supprimer la vue' })
    .getByRole('button', { name: 'Supprimer' })
    .click();
}
async function viewsOnly(audiences) {
  for (;;) {
    const current = await settings
      .getByRole('combobox', { name: 'Vue affichée et exportée' })
      .locator('option')
      .allInnerTexts();
    if (current.length <= 1) break;
    await settings.getByRole('combobox', { name: 'Vue affichée et exportée' }).selectOption({ index: 1 });
    await deleteCurrentView();
  }
  for (const a of audiences) await addView(a);
  await settings.getByRole('combobox', { name: 'Vue affichée et exportée' }).selectOption({ index: 0 });
}
async function basePreset(preset) {
  await settings.getByRole('combobox', { name: 'Préréglage', exact: true }).selectOption(preset);
}
async function saveTemplate(name) {
  await page.getByRole('button', { name: 'Fermer' }).first().click();
  await waitSaved();
  await page.getByRole('button', { name: 'Modèles', exact: true }).click();
  const dialog = page.getByTestId('templates-dialog');
  await dialog.getByLabel('Enregistrer ce plan comme modèle (nom)').fill(name);
  await dialog.getByTestId('template-save').click();
  await dialog.locator(`[data-template="${name}"]`).waitFor();
  const file = await download(() =>
    dialog.getByRole('button', { name: `Exporter le modèle « ${name} »` }).click(),
  );
  writeFileSync(join(outDir, file.name), file.bytes);
  await page.keyboard.press('Escape');
  await page.getByTestId('open-print').click();
  await page.getByTestId('print-dialog').waitFor();
  return file.name;
}
const templates = [];
await viewsOnly(['employees', 'suppliers', 'management', 'safety']);
await basePreset('standard');
templates.push(await saveTemplate('Modèle PAMM — général'));
await viewsOnly(['management', 'safety']);
await basePreset('field');
templates.push(await saveTemplate('Modèle PAMM — circulation'));
await viewsOnly(['suppliers']);
await basePreset('supplier');
templates.push(await saveTemplate('Modèle PAMM — fournisseur'));
await viewsOnly(['employees']);
await basePreset('employees');
templates.push(await saveTemplate('Modèle PAMM — employés'));
await page.getByRole('button', { name: 'Fermer' }).first().click();
const templateCheck = templates.map((file) => {
  const entries = unzipSync(new Uint8Array(readFileSync(join(outDir, file))));
  const t = JSON.parse(strFromU8(entries['modele.json']));
  return {
    fichier: file,
    vues: t.views.map((v) => v.name),
    style: t.print.style.preset,
    entreprise: t.titleBlock.company,
    aucunObjet: !('objects' in t),
  };
});
log('Modèles PAMM', { templateCheck });

// 7. Photo d'origine intacte ; le plan de démonstration n'a pas été modifié par les vues.
docs = await readDocs();
const demo = docs.find((d) => d.plan.name === demoName);
log('Intégrité', {
  photoSourceInchangee: sha(readFileSync(photo)) === photoSha,
  // Seul changement : l'étiquette déplacée après acceptation de la proposition.
  objetsModifies: Object.keys(demo.objects)
    .filter((id) => JSON.stringify(demo.objects[id]) !== JSON.stringify(JSON.parse(baseline)[id]))
    .map((id) => demo.objects[id].name),
  statut: demo.plan.titleBlock.status,
  nord: demo.plan.northStatus,
  calibration: demo.plan.calibration,
});

// Rapport de lisibilité (Markdown).
const md = [
  '# Rapport de lisibilité — Camp 105 (Phase 6)',
  '',
  'Plan ILLUSTRATIF, non calibré, nord non défini, « À valider sur le terrain — NON APPROUVÉ ».',
  'Analyse de l’éditeur (même moteur que les PDF) pour chaque vue, puis contrôle indépendant sur les PDF produits.',
  '',
  '## Analyse dans l’éditeur',
  '',
  ...readability.flatMap((r) => [
    `### ${r.vue}`,
    '',
    `- ${r.bilan}`,
    ...r.problemes.map((p) => `- ${p}`),
    '',
  ]),
  '## Contrôle des PDF par public',
  '',
  '| Fichier | Pages | Format (mm) | Chevauchements | Hors page | Plus petit texte |',
  '| --- | --- | --- | --- | --- | --- |',
  ...pdfChecks.map(
    (c) =>
      `| ${c.fichier} | ${c.pages} | ${c.formatMm.join(' × ')} | ${c.chevauchements} | ${c.horsPage} | ${c.plusPetitTextePt} pt |`,
  ),
  '',
].join('\n');
writeFileSync(join(outDir, 'camp105-phase6-rapport-lisibilite.md'), md);
report.errors = errors;
writeFileSync(join(outDir, 'camp105-phase6-rapport.json'), JSON.stringify(report, null, 2));
console.log('Erreurs de page :', errors);
await browser.close();
