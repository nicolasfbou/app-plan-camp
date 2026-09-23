/**
 * Démonstration de la Phase 9 sur une COPIE du projet Camp 105 (photo réelle jamais modifiée).
 * Usage : node bench/camp105-phase9.mjs <photo> <camp-105-phase7-revisions.campplan> <dossier-sortie>
 * Prérequis : `npm run build` puis le serveur jetable (PostgreSQL temporaire, comptes de test) :
 *   PORT=8787 npx tsx --tsconfig server/tsconfig.json server/scripts/e2e-server.ts
 *
 * Le plan reste ILLUSTRATIF (positions d'exemple, non calibré, nord non défini). Aucune révision
 * n'est approuvée par ce script (l'approbation reste un choix explicite d'une personne autorisée).
 * Tout passe par l'interface, avec deux « ordinateurs » (deux profils de navigateur isolés) :
 *   1. projet local importé → publié dans PAMM (récapitulatif affiché, confirmé) ;
 *   2. ouvert sur un second profil (N. Tremblay, éditeur) ;
 *   3. poste 1 hors ligne ; 4. modification hors ligne ;
 *   5. poste 2 modifie la version serveur ; 6. retour en ligne ; 7. conflit détecté ;
 *   8. les deux versions conservées (copie) ; 9. révision créée ; 10. journal d'audit vérifié.
 * SHA-256 de la photo vérifié : fichier d'origine, serveur (octets téléchargés), deux postes.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const [photo, phase7, outDir] = process.argv.slice(2);
if (!photo || !phase7 || !outDir)
  throw new Error('Usage : node bench/camp105-phase9.mjs <photo> <phase7.campplan> <dossier>');
const APP = process.env.APP_URL ?? 'http://localhost:8787/';
const PASSWORD = process.env.E2E_PASSWORD ?? 'mot-de-passe-solide-2026';
const EXPECTED = '9a406cc07a78843adc334391ad7aea6fabc953288a2afab24cca055cd513f911';
mkdirSync(outDir, { recursive: true });
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const photoShaBefore = sha(readFileSync(photo));
const report = { photoSha256: photoShaBefore, attendu: EXPECTED, steps: [] };
const log = (step, data = {}) => {
  report.steps.push({ step, ...data });
  console.log(step, JSON.stringify(data));
};
const out = (name) => join(outDir, name);

const browser = await chromium.launch({
  executablePath: process.env.PW_CHROMIUM_PATH ?? '/opt/pw-browsers/chromium',
});
const errors = [];
async function computer(label) {
  const context = await browser.newContext({ baseURL: APP, viewport: { width: 1600, height: 1100 } });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(`${label} : ${e.message}`));
  await page.goto(APP);
  return { context, page };
}
async function login(page, email, { screenshot } = {}) {
  await page.goto(`${APP}#/connexion`);
  await page.getByLabel('Courriel').fill(email);
  await page.getByLabel('Mot de passe').fill(PASSWORD);
  if (screenshot) await page.screenshot({ path: out(screenshot) });
  // Choix EXPLICITE : poste de confiance (données conservées sur l'appareil, averti).
  await page.getByTestId('device-mode').getByRole('radio').nth(0).check();
  await page.getByTestId('login-submit').click();
  await page.getByTestId('workspace-bar').waitFor();
  await page.getByTestId('workspace-select').filter({ hasText: 'PAMM' }).waitFor();
}
const indicator = (page) => page.getByTestId('sync-indicator').first();
const waitState = async (page, state, timeout = 60_000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if ((await indicator(page).getAttribute('data-state')) === state) return;
    await page.waitForTimeout(250);
  }
  throw new Error(
    `État de synchro « ${state} » non atteint (actuel : ${await indicator(page).getAttribute('data-state')}).`,
  );
};
const waitSaved = (page) =>
  page
    .getByTestId('save-status')
    .filter({ hasText: /^Enregistré$/ })
    .waitFor({ timeout: 30_000 });
async function addLabel(page, x, y, text) {
  await page.keyboard.press('g');
  const box = await page.getByTestId('canvas-container').boundingBox();
  await page.mouse.click(box.x + x, box.y + y);
  await page.getByTestId('text-editor').fill(text);
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
}
const api = async (page, path) => {
  const r = await page.request.get(new URL(path, APP).toString(), { headers: { 'X-CampPlanner': '1' } });
  if (!r.ok()) throw new Error(`${path} → ${r.status()}`);
  return r;
};
const idbDocs = (page) =>
  page.evaluate(async () => {
    const names = (await indexedDB.databases())
      .map((d) => d.name)
      .filter((n) => n?.startsWith('campplanner-'));
    const out = [];
    for (const name of names)
      await new Promise((resolve) => {
        const open = indexedDB.open(name);
        open.onsuccess = () => {
          const r = open.result.transaction('plans').objectStore('plans').getAll();
          r.onsuccess = () => {
            for (const x of r.result)
              out.push({ db: name, name: x.document.plan.name, sha: x.document.plan.baseImage?.sha256 });
            open.result.close();
            resolve();
          };
        };
      });
    return out;
  });

// ─── Poste 1 (M. Gagnon, gestionnaire) : projet LOCAL importé depuis la copie Phase 7 ───
const p1 = await computer('Poste 1');
const ascii = join(tmpdir(), `camp105-p9-${Date.now()}.campplan`);
copyFileSync(phase7, ascii); // copie de travail : l'original de la phase 7 n'est pas touché
await p1.page.goto(`${APP}#/`);
await p1.page.getByTestId('campplan-input').setInputFiles(ascii);
await p1.page.getByTestId('import-verified').waitFor({ timeout: 60_000 });
await p1.page.getByRole('button', { name: 'Importer', exact: true }).click();
await p1.page.getByTestId('navigation-controls').waitFor({ timeout: 120_000 });
const localPlanUrl = p1.page.url();
log('1a. Projet local importé (espace sans compte)', { url: localPlanUrl.replace(APP, '/') });

// Connexion (type d'appareil demandé), puis retour à l'espace local pour publier.
await login(p1.page, 'gestion@pamm.test', { screenshot: 'camp105-phase9-connexion.png' });
await p1.page.getByTestId('workspace-select').selectOption('local');
await p1.page.waitForFunction(
  () => document.querySelector('[data-testid="workspace-select"]')?.value === 'local',
);
const campName = (await p1.page.getByRole('link').filter({ hasText: 'Camp 105' }).first().innerText()).split(
  '\n',
)[0];
await p1.page
  .getByRole('button', { name: /^Publier dans l’organisation/ })
  .first()
  .click();
const publish = p1.page.getByTestId('publish-dialog');
await publish.getByTestId('publish-summary').waitFor({ timeout: 60_000 });
await publish.getByTestId('publish-shas').waitFor();
await p1.page.screenshot({ path: out('camp105-phase9-publication-recapitulatif.png') });
const summary = (await publish.innerText()).replace(/\n+/g, ' | ');
log('1b. Récapitulatif avant publication', { camp: campName, recapitulatif: summary });
await p1.page.getByTestId('publish-confirm').click();
await publish.getByTestId('publish-done').waitFor({ timeout: 180_000 });
await p1.page.getByRole('button', { name: 'Ouvrir l’espace PAMM' }).click();
await p1.page.waitForFunction(
  () => document.querySelector('[data-testid="workspace-select"]')?.value !== 'local',
);
await waitState(p1.page, 'synced', 180_000);
const serverPlans = (await (await api(p1.page, '/api/plans')).json()).plans;
const plan = serverPlans.find((p) => p.name.startsWith('Circulation'));
const serverPlan = await (await api(p1.page, `/api/plans/${plan.id}`)).json();
const serverSha = serverPlan.document.plan.baseImage.sha256;
const serverBytes = await (await api(p1.page, `/api/files/${serverSha}`)).body();
log('1c. Publié dans PAMM', {
  plans: serverPlans.map((p) => p.name),
  versionServeur: serverPlan.serverVersion,
  shaDocumentServeur: serverSha,
  shaOctetsServeur: sha(serverBytes),
  tailleOctets: serverBytes.length,
  calibration: serverPlan.document.plan.calibration ?? null,
  nord: serverPlan.document.plan.northStatus,
});
const revs = (await (await api(p1.page, `/api/plans/${plan.id}/revisions`)).json()).revisions;
log('1d. Révisions publiées (historiques, conservées telles quelles)', {
  revisions: revs.map((r) => ({ code: r.meta?.label, statut: r.meta?.status })),
});
const siteId = plan.campId ?? plan.siteId;
const planPath = `#/camp/${siteId}/plan/${plan.id}`;

// ─── Poste 2 (N. Tremblay, éditeur) : ouvre le projet reçu du serveur ───
const p2 = await computer('Poste 2');
await login(p2.page, 'edition@pamm.test');
await waitState(p2.page, 'synced', 180_000);
await p2.page.goto(`${APP}${planPath}`);
await p2.page.getByTestId('navigation-controls').waitFor({ timeout: 120_000 });
await p2.page.waitForTimeout(1500);
await p2.page.screenshot({ path: out('camp105-phase9-poste2-ouvert.png') });
log('2. Ouvert sur le second profil', { plansPoste2: await idbDocs(p2.page) });

// ─── 3–4. Poste 1 hors ligne, modification locale ───
await p1.page.goto(`${APP}${planPath}`);
await p1.page.getByTestId('navigation-controls').waitFor({ timeout: 120_000 });
await waitState(p1.page, 'synced');
await p1.context.setOffline(true);
await addLabel(p1.page, 520, 380, 'EXEMPLE — modifié hors ligne (poste 1)');
await waitSaved(p1.page);
await waitState(p1.page, 'offline');
await p1.page.screenshot({ path: out('camp105-phase9-hors-ligne.png') });
log('3-4. Poste 1 hors ligne : modification enregistrée localement', {
  indicateur: await indicator(p1.page).innerText(),
});

// ─── 5. Poste 2 modifie la version serveur ───
await addLabel(p2.page, 900, 520, 'EXEMPLE — modifié sur le serveur (poste 2)');
await waitSaved(p2.page);
for (let i = 0; ; i++) {
  const doc = (await (await api(p2.page, `/api/plans/${plan.id}`)).json()).document;
  if (Object.values(doc.objects).some((o) => o.text?.includes('poste 2'))) break;
  if (i > 120) throw new Error('La modification du poste 2 n’est pas arrivée sur le serveur.');
  await p2.page.waitForTimeout(500);
}
const afterB = await (await api(p2.page, `/api/plans/${plan.id}`)).json();
log('5. Poste 2 : version serveur modifiée', {
  versionServeur: afterB.serverVersion,
  modifiePar: afterB.updatedBy,
});

// ─── 6–7. Retour en ligne : conflit détecté, rien d'écrasé ───
await p1.context.setOffline(false);
await waitState(p1.page, 'conflict');
const stillB = await (await api(p1.page, `/api/plans/${plan.id}`)).json();
await p1.page.getByTestId('open-sync-conflict').click();
const conflict = p1.page.getByTestId('sync-conflict-dialog');
await conflict.waitFor();
await p1.page.waitForTimeout(500);
await p1.page.screenshot({ path: out('camp105-phase9-conflit.png') });
log('6-7. Retour en ligne : conflit détecté', {
  versionServeurInchangee: stillB.serverVersion === afterB.serverVersion,
  miennes: (await conflict.getByTestId('conflict-mine').innerText()).replace(/\n+/g, ' | '),
  serveur: (await conflict.getByTestId('conflict-theirs').innerText()).replace(/\n+/g, ' | '),
});

// ─── 8. Garder les deux versions (copie) ───
await conflict.getByTestId('conflict-copy-sync').click();
await conflict.waitFor({ state: 'hidden' });
await waitState(p1.page, 'synced', 120_000);
const finalPlans = (await (await api(p1.page, '/api/plans')).json()).plans;
const texts = async (id) =>
  Object.values((await (await api(p1.page, `/api/plans/${id}`)).json()).document.objects)
    .map((o) => o.text)
    .filter((t) => t?.startsWith('EXEMPLE —'));
const kept = [];
for (const p of finalPlans.filter((p) => p.name.startsWith('Circulation')))
  kept.push({ plan: p.name, version: p.serverVersion, etiquettesDemo: await texts(p.id) });
log('8. Les deux versions conservées sur le serveur', { plans: kept });

// ─── 9. Révision créée (brouillon — AUCUNE approbation automatique) ───
await p1.page.goto(`${APP}${planPath}`);
await p1.page.getByTestId('navigation-controls').waitFor({ timeout: 120_000 });
await p1.page.getByRole('tab', { name: 'Révisions' }).click();
await p1.page.getByTestId('create-revision').click();
await p1.page.getByTestId('create-revision-dialog').getByLabel('Auteur').fill('M. Gagnon');
await p1.page.getByTestId('confirm-create-revision').click();
let revsAfter = [];
for (let i = 0; revsAfter.length <= revs.length; i++) {
  if (i > 240) throw new Error('La révision créée n’est pas arrivée sur le serveur.');
  await p1.page.waitForTimeout(500);
  revsAfter = (await (await api(p1.page, `/api/plans/${plan.id}/revisions`)).json()).revisions;
}
await waitState(p1.page, 'synced', 120_000);
await p1.page.screenshot({ path: out('camp105-phase9-revision.png') });
log('9. Révision créée et synchronisée', {
  revisions: revsAfter.map((r) => ({
    code: r.meta?.label,
    statut: r.meta?.status,
    creePar: r.createdBy,
    verification: r.verificationType,
    chainage: r.chainHash?.slice(0, 16),
  })),
});

// ─── 10. Journal d'audit ───
await p1.page.goto(`${APP}#/organisation`);
await p1.page.getByTestId('audit-row').first().waitFor({ timeout: 30_000 });
await p1.page.screenshot({ path: out('camp105-phase9-audit.png'), fullPage: true });
const events = (await (await api(p1.page, '/api/audit?limit=200')).json()).events;
log('10. Journal d’audit (serveur, ajout seul)', {
  evenements: events.map((e) => `${e.at} · ${e.userName ?? '—'} · ${e.action} · ${e.targetKind ?? ''}`),
});

// ─── SHA-256 de la photo partout ───
const shaP1 = await idbDocs(p1.page);
const shaP2 = await idbDocs(p2.page);
const photoShaAfter = sha(readFileSync(photo));
const everywhere = [serverSha, sha(serverBytes), ...shaP1.map((d) => d.sha), ...shaP2.map((d) => d.sha)];
log('SHA-256 de la photo', {
  fichierOriginalAvant: photoShaBefore,
  fichierOriginalApres: photoShaAfter,
  originalInchange: photoShaBefore === photoShaAfter && photoShaAfter === EXPECTED,
  serveur: sha(serverBytes),
  poste1: shaP1,
  poste2: shaP2,
  identiquePartout: everywhere.every((s) => s === EXPECTED),
});
report.erreursPage = errors;
writeFileSync(out('camp105-phase9-rapport.json'), JSON.stringify(report, null, 2));
await browser.close();
if (!everywhere.every((s) => s === EXPECTED) || photoShaAfter !== EXPECTED)
  throw new Error('SHA-256 de la photo différent : voir le rapport.');
console.log('Démonstration Phase 9 terminée.');
