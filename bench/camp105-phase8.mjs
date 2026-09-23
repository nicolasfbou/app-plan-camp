/**
 * Démonstration de la Phase 8 sur la VRAIE photo aérienne du Camp 105 (jamais modifiée).
 * Usage : node bench/camp105-phase8.mjs <photo> <camp-105-phase7-revisions.campplan> <dossier-sortie>
 * Prérequis : `npm run build && npx vite preview --port 4178` (ou APP_URL).
 *
 * Le plan reste ILLUSTRATIF (positions d'exemple, non calibré, nord non défini). Aucune révision
 * n'est approuvée par ce script. Tout passe par l'interface :
 * - dossier de sauvegarde externe (Chromium : le sélecteur de dossier exige un clic humain ; il
 *   est remplacé ici par un dossier du stockage privé du navigateur, même API d'écriture) ;
 * - sauvegarde manuelle, puis sauvegarde AUTOMATIQUE à la création d'une révision (C) ;
 * - deux onglets : le second en lecture seule ; conflit simulé (renommage ailleurs pendant
 *   l'édition) résolu par « Enregistrer dans une copie » ;
 * - santé du projet, nettoyage, journal, diagnostic, copie de secours ;
 * - copie de secours réimportée dans un navigateur VIDE ; SHA-256 de la photo revérifié.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { strFromU8, unzipSync } from 'fflate';

const [photo, phase7, outDir] = process.argv.slice(2);
if (!photo || !phase7 || !outDir)
  throw new Error('Usage : node bench/camp105-phase8.mjs <photo> <phase7.campplan> <dossier>');
const APP = process.env.APP_URL ?? 'http://localhost:4178/';
mkdirSync(outDir, { recursive: true });
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const photoSha = sha(readFileSync(photo));
const report = { photoSha256: photoSha, steps: [] };
const log = (step, data = {}) => {
  report.steps.push({ step, ...data });
  console.log(step, JSON.stringify(data));
};
const out = (name) => join(outDir, name);

const browser = await chromium.launch({
  executablePath: process.env.PW_CHROMIUM_PATH ?? '/opt/pw-browsers/chromium',
});
const newContext = async () => {
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    acceptDownloads: true,
  });
  // Dossier de sauvegarde : le sélecteur natif exige un geste humain ; dossier privé équivalent.
  await context.addInitScript(() => {
    window.showDirectoryPicker = async () =>
      (await navigator.storage.getDirectory()).getDirectoryHandle('Sauvegardes CampPlanner', {
        create: true,
      });
  });
  return context;
};
const context = await newContext();
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(APP);

async function download(trigger, p = page) {
  const [d] = await Promise.all([p.waitForEvent('download', { timeout: 300_000 }), trigger()]);
  return { name: d.suggestedFilename(), bytes: readFileSync(await d.path()) };
}
async function importFile(p, path, { recovery = false } = {}) {
  const ascii = join(tmpdir(), `camp105-p8-${Date.now()}.campplan`);
  copyFileSync(path, ascii);
  await p.goto(`${APP}#/`);
  await p.getByTestId('campplan-input').setInputFiles(ascii);
  if (recovery) {
    await p.getByTestId('import-try-recovery').click({ timeout: 60_000 });
    await p.getByTestId('import-recovery').waitFor({ timeout: 60_000 });
  } else await p.getByTestId('import-verified').waitFor({ timeout: 60_000 });
  await p.getByRole('button', { name: 'Importer', exact: true }).click();
  await p.getByTestId('navigation-controls').waitFor({ timeout: 120_000 });
}
const idb = (p, store) =>
  p.evaluate(
    (store) =>
      new Promise((resolve) => {
        const open = indexedDB.open('campplanner');
        open.onsuccess = () => {
          const r = open.result.transaction(store).objectStore(store).getAll();
          r.onsuccess = () => {
            resolve(r.result);
            open.result.close();
          };
        };
      }),
    store,
  );
const backupFiles = (p = page) =>
  p.evaluate(async () => {
    const outList = [];
    const walk = async (dir, path) => {
      for await (const entry of dir.values())
        if (entry.kind === 'directory') await walk(entry, `${path}${entry.name}/`);
        else outList.push(`${path}${entry.name}`);
    };
    await walk(
      await (await navigator.storage.getDirectory()).getDirectoryHandle('Sauvegardes CampPlanner'),
      '',
    );
    return outList.sort();
  });
async function addLabel(p, x, y, text) {
  await p.keyboard.press('g');
  const box = await p.getByTestId('canvas-container').boundingBox();
  await p.mouse.click(box.x + x, box.y + y);
  await p.getByTestId('text-editor').fill(text);
  await p.keyboard.press('Enter');
  await p.keyboard.press('Escape');
}
const waitSaved = (p = page) =>
  p
    .getByTestId('save-status')
    .filter({ hasText: /^Enregistré$/ })
    .waitFor({ timeout: 30_000 });

// 1. Projet de la phase 7 (révisions A et B, photo réelle).
await importFile(page, phase7);
const planUrl = page.url();
let [doc] = await idb(page, 'plans').then((r) => r.map((x) => x.document));
log('Projet importé', {
  plan: doc.plan.name,
  photoSha256: doc.plan.baseImage.sha256,
  photoIdentique: doc.plan.baseImage.sha256 === photoSha,
  revisions: (await idb(page, 'revisions')).length,
  calibration: doc.plan.calibration,
  nord: doc.plan.northStatus,
});

// 2. Sauvegarde externe : dossier choisi, sauvegarde immédiate, puis automatique (révision C).
const dialog = page.getByTestId('maintenance-dialog');
await page.getByRole('button', { name: 'Santé et sauvegardes' }).click();
await dialog.getByRole('tab', { name: 'Sauvegardes externes' }).click();
await dialog.getByTestId('backup-choose-folder').click();
await dialog.getByTestId('backup-folder-state').filter({ hasText: 'Sauvegardes CampPlanner' }).waitFor();
await dialog.getByTestId('backup-this-plan').click();
await dialog.getByTestId('backup-message').filter({ hasText: 'Sauvegarde écrite' }).waitFor();
await page.screenshot({ path: out('camp105-phase8-sauvegardes.png') });
await page.keyboard.press('Escape');
await page.getByRole('tab', { name: 'Révisions' }).click();
await page.getByTestId('create-revision').click();
await page.getByTestId('create-revision-dialog').getByLabel('Auteur').fill('Démonstration Phase 8');
await page.getByTestId('confirm-create-revision').click();
for (let i = 0; i < 60 && !(await backupFiles()).some((f) => f.endsWith('revision-C.campplan')); i++)
  await page.waitForTimeout(500);
const files = await backupFiles();
log('Sauvegardes externes (dossier)', { fichiers: files });
const autoFile = files.find((f) => f.endsWith('revision-C.campplan'));
if (!autoFile) throw new Error('Sauvegarde automatique après révision absente.');

// 3. Deux onglets : le second en lecture seule.
const second = await context.newPage();
second.on('pageerror', (e) => errors.push(e.message));
await second.goto(planUrl);
await second.getByTestId('lock-banner').waitFor({ timeout: 30_000 });
await second.screenshot({ path: out('camp105-phase8-deuxieme-onglet-lecture-seule.png') });
log('Deuxième onglet', {
  bandeau: await second.getByTestId('lock-banner').innerText(),
  premierOngletEditeur: (await page.getByTestId('lock-banner').count()) === 0,
});
await second.close();

// 4. Conflit simulé : renommage depuis la liste des plans pendant que l'éditeur modifie.
await addLabel(page, 700, 420, 'EXEMPLE P8');
await waitSaved();
const other = await context.newPage();
await other.goto(planUrl.replace(/\/plan\/.*$/, ''));
await other.getByRole('button', { name: `Renommer ${doc.plan.name}` }).click();
await other.getByLabel('Nom du plan').fill(`${doc.plan.name} (renommé ailleurs)`);
await other.getByRole('button', { name: 'Enregistrer' }).click();
await other.getByTestId('plan-row').filter({ hasText: 'renommé ailleurs' }).waitFor();
await other.close();
await addLabel(page, 760, 480, 'EXEMPLE P8 bis');
await page.getByTestId('conflict-dialog').waitFor({ timeout: 15_000 });
await page.screenshot({ path: out('camp105-phase8-conflit.png') });
await page.getByTestId('conflict-copy').click();
await page.getByTestId('conflict-dialog').waitFor({ state: 'hidden' });
const plansAfter = (await idb(page, 'plans')).map((r) => r.document.plan.name);
log('Conflit résolu par une copie', { plans: plansAfter });

// 5. Santé du projet, nettoyage, journal, diagnostic, copie de secours.
await page.getByRole('button', { name: 'Santé et sauvegardes' }).click();
await dialog.getByRole('tab', { name: 'Santé du projet' }).click();
await dialog.getByTestId('health-checks').locator('[data-check="photo-sha"]').waitFor({ timeout: 120_000 });
await page.waitForTimeout(500);
await dialog.screenshot({ path: out('camp105-phase8-sante-du-projet.png') });
const checks = await dialog
  .getByTestId('health-checks')
  .locator('[data-check]')
  .evaluateAll((els) =>
    els.map((e) => ({
      id: e.dataset.check,
      status: e.dataset.status,
      texte: e.innerText.replace(/\s+/g, ' '),
    })),
  );
log('Santé du projet', {
  global: await dialog.getByTestId('health-overall').getAttribute('data-status'),
  controles: checks,
});
await dialog.getByRole('tab', { name: 'Nettoyage' }).click();
await dialog.getByTestId('cleanup-analyse').click();
await Promise.race([
  dialog.getByTestId('cleanup-items').waitFor(),
  dialog.getByTestId('cleanup-empty').waitFor(),
]);
await dialog.screenshot({ path: out('camp105-phase8-nettoyage.png') });
log('Nettoyage', {
  resultat: (await dialog.getByTestId('cleanup-empty').count())
    ? 'rien à nettoyer'
    : await dialog.getByTestId('cleanup-items').innerText(),
});
await dialog.getByRole('tab', { name: 'Journal des erreurs' }).click();
await dialog.screenshot({ path: out('camp105-phase8-journal.png') });
await dialog.getByRole('tab', { name: 'Diagnostic' }).click();
const diagnostic = await download(() => dialog.getByTestId('diagnostic-export').click());
writeFileSync(out('camp105-phase8-diagnostic.json'), diagnostic.bytes);
const diagnosticText = diagnostic.bytes.toString('utf8');
log('Diagnostic', {
  fichier: diagnostic.name,
  octets: diagnostic.bytes.length,
  contientNomDuPlan: diagnosticText.includes(doc.plan.name),
  contientShaPhoto: diagnosticText.includes(photoSha),
});
await page.keyboard.press('Escape');
await page.goto(planUrl);
await page.getByTestId('navigation-controls').waitFor({ timeout: 120_000 });
const emergency = await download(() =>
  page.getByRole('button', { name: 'Exporter une copie de secours maintenant' }).click(),
);
const emergencyPath = out('camp105-phase8-copie-de-secours.campplan');
writeFileSync(emergencyPath, emergency.bytes);
const zip = unzipSync(new Uint8Array(emergency.bytes));
const manifest = JSON.parse(strFromU8(zip['manifest.json']));
log('Copie de secours', {
  fichier: emergency.name,
  octets: emergency.bytes.length,
  complete: manifest.emergency?.complete,
  problemes: manifest.emergency?.problems,
  revisions: manifest.revisions.map((r) => `${r.meta.label} (${r.meta.status})`),
  photoSha256: manifest.files.find((f) => f.role === 'background')?.sha256,
});

// 6. Navigateur VIDE : réimport de la copie de secours.
const empty = await newContext();
const fresh = await empty.newPage();
fresh.on('pageerror', (e) => errors.push(e.message));
await fresh.goto(APP);
const before = await idb(fresh, 'plans');
await importFile(fresh, emergencyPath, { recovery: manifest.emergency?.complete === false });
const [reDoc] = (await idb(fresh, 'plans')).map((r) => r.document);
const blobs = await idb(fresh, 'blobs');
const photoBlob = blobs.find((b) => b.id === reDoc.plan.baseImage.blobId);
const reSha = sha(Buffer.from(photoBlob.bytes));
await fresh.getByRole('tab', { name: 'Révisions' }).click();
await fresh.getByTestId('revision-card').first().waitFor();
await fresh.screenshot({ path: out('camp105-phase8-navigateur-vide-reimport.png') });
log('Navigateur vide : réimport', {
  plansAvant: before.length,
  plan: reDoc.plan.name,
  revisions: await fresh.getByTestId('revision-card').count(),
  revisionsAlterees: await fresh.getByTestId('revision-card').filter({ hasText: 'altérée' }).count(),
  photoSha256Recalcule: reSha,
  photoIdentique: reSha === photoSha,
});
await fresh.getByRole('button', { name: 'Santé et sauvegardes' }).click();
await fresh.getByTestId('health-checks').locator('[data-check="photo-sha"]').waitFor({ timeout: 120_000 });
await fresh
  .getByTestId('maintenance-dialog')
  .screenshot({ path: out('camp105-phase8-sante-apres-reimport.png') });
log('Santé après réimport', {
  global: await fresh.getByTestId('health-overall').getAttribute('data-status'),
});

const originalAfter = sha(readFileSync(photo));
log('Photo originale sur disque', { sha256: originalAfter, inchangee: originalAfter === photoSha });
report.pageErrors = errors;
writeFileSync(out('camp105-phase8-rapport.json'), JSON.stringify(report, null, 2));
await browser.close();
if (originalAfter !== photoSha || reSha !== photoSha) throw new Error('SHA-256 de la photo différent !');
