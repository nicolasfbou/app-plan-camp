/**
 * Phase 9.1 — scénario final Camp 105 sur une COPIE du projet, contre la pile de déploiement de
 * référence (Docker : PostgreSQL 16, serveur, HTTPS Caddy) d'un hôte de TEST. La photo d'origine
 * n'est jamais modifiée. Le plan reste illustratif (non calibré, nord non défini) ; aucune
 * révision n'est approuvée par ce script.
 *
 *   ADMIN_PASSWORD=… CAMPPLANNER_VERSION=… (variables de deploy/docker-compose.yml) \
 *   node bench/camp105-phase9-1.mjs <photo> <camp-105-phase7-revisions.campplan> <dossier-sortie>
 *
 * Étapes : 1 publication · 2 deux comptes autorisés · 3 modification hors ligne · 4 modification
 * serveur par le second poste · 5 conflit détecté · 6 deux versions conservées · 7 compte
 * désactivé · 8 ses requêtes refusées · 9 intégrité des révisions · 10 export .campplan ·
 * 11 restauration sur un environnement de test isolé · 12 comparaison des SHA-256.
 */
import { execSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { chromium, request as pwRequest } from '@playwright/test';
import { unzipSync } from 'fflate';

const [photo, phase7, outDir] = process.argv.slice(2);
if (!photo || !phase7 || !outDir)
  throw new Error('Usage : node bench/camp105-phase9-1.mjs <photo> <phase7.campplan> <dossier>');
const APP = process.env.APP_URL ?? 'https://localhost:8443/';
const RESTORED = process.env.RESTORED_URL ?? 'https://localhost:9443/';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) throw new Error('ADMIN_PASSWORD requis (administrateur créé par bootstrap).');
const EXPECTED = '9a406cc07a78843adc334391ad7aea6fabc953288a2afab24cca055cd513f911';
const DEPLOY = join(dirname(new URL(import.meta.url).pathname), '..', 'deploy');
mkdirSync(outDir, { recursive: true });
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const photoBefore = sha(readFileSync(photo));
const report = { photoSha256: photoBefore, attendu: EXPECTED, pile: APP, steps: [] };
const log = (step, data = {}) => {
  report.steps.push({ step, ...data });
  console.log(step, JSON.stringify(data).slice(0, 600));
};
const out = (name) => join(outDir, name);
const CSRF = { 'X-CampPlanner': '1' };
const passwords = {
  'gestion@pamm.test': `gestion-${randomBytes(9).toString('hex')}`,
  'edition@pamm.test': `edition-${randomBytes(9).toString('hex')}`,
};

// --- Administration : comptes invités (aucun compte de test préexistant sur cette pile) -------
const admin = await pwRequest.newContext({ baseURL: APP, ignoreHTTPSErrors: true, extraHTTPHeaders: CSRF });
const adminLogin = await admin.post('/api/auth/login', {
  data: { email: 'admin@pamm.test', password: ADMIN_PASSWORD, deviceMode: 'trusted' },
});
if (!adminLogin.ok()) throw new Error(`Connexion administrateur : ${adminLogin.status()}`);
const invitees = [
  ['gestion@pamm.test', 'manager', 'M. Gagnon'],
  ['edition@pamm.test', 'editor', 'N. Tremblay'],
];
for (const [email, role, name] of invitees) {
  const inv = await (await admin.post('/api/invitations', { data: { email, role } })).json();
  const anon = await pwRequest.newContext({ baseURL: APP, ignoreHTTPSErrors: true, extraHTTPHeaders: CSRF });
  const ok = await anon.post(`/api/invitations/${inv.token}/accept`, {
    data: { displayName: name, password: passwords[email] },
  });
  if (!ok.ok()) throw new Error(`Invitation ${email} : ${ok.status()} ${await ok.text()}`);
  await anon.dispose();
}
log('0. Comptes invités par l’administrateur', { comptes: invitees.map(([e, r]) => `${e} (${r})`) });

// --- Navigateurs --------------------------------------------------------------------------------
const browser = await chromium.launch({
  executablePath: process.env.PW_CHROMIUM_PATH ?? '/opt/pw-browsers/chromium',
});
const errors = [];
async function computer(label) {
  const context = await browser.newContext({
    baseURL: APP,
    ignoreHTTPSErrors: true,
    acceptDownloads: true,
    viewport: { width: 1600, height: 1100 },
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(`${label} : ${e.message}`));
  await page.goto(APP);
  return { context, page };
}
async function login(page, email) {
  await page.goto(`${APP}#/connexion`);
  await page.getByLabel('Courriel').fill(email);
  await page.getByLabel('Mot de passe').fill(passwords[email]);
  await page.getByTestId('device-mode').getByRole('radio').nth(0).check(); // poste de confiance, choisi
  await page.getByTestId('login-submit').click();
  // Point de synchronisation : l'espace PAMM existe (connexion terminée), pas seulement la barre.
  await page.getByTestId('workspace-select').filter({ hasText: 'PAMM' }).waitFor();
  await page.waitForFunction(() =>
    document.querySelector('[data-testid="workspace-select"]')?.value?.startsWith('org-'),
  );
}
const indicator = (page) => page.getByTestId('sync-indicator').first();
const waitState = async (page, state, timeout = 90_000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const s = await indicator(page)
      .getAttribute('data-state')
      .catch(() => null);
    if (
      s === state &&
      (state !== 'synced' || (await indicator(page).getAttribute('data-syncing')) === 'false')
    )
      return;
    await page.waitForTimeout(250);
  }
  throw new Error(
    `État « ${state} » non atteint (actuel : ${await indicator(page).getAttribute('data-state')}).`,
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
const getJson = async (ctx, path) => {
  const r = await ctx.get(path, { headers: CSRF });
  if (!r.ok()) throw new Error(`${path} → ${r.status()}`);
  return r.json();
};

// 1. Publication d'une COPIE du projet Camp 105 dans PAMM ----------------------------------------
const p1 = await computer('Poste 1');
const copy = join(tmpdir(), `camp105-p91-${Date.now()}.campplan`);
copyFileSync(phase7, copy);
await p1.page.getByTestId('campplan-input').setInputFiles(copy);
await p1.page.getByTestId('import-verified').waitFor({ timeout: 60_000 });
await p1.page.getByRole('button', { name: 'Importer', exact: true }).click();
await p1.page.getByTestId('navigation-controls').waitFor({ timeout: 120_000 });
await login(p1.page, 'gestion@pamm.test');
await p1.page.getByTestId('workspace-select').selectOption('local');
await p1.page.waitForFunction(
  () => document.querySelector('[data-testid="workspace-select"]')?.value === 'local',
);
await p1.page
  .getByRole('button', { name: /^Publier dans l’organisation/ })
  .first()
  .click({ timeout: 30_000 })
  .catch(async (error) => {
    await p1.page.screenshot({ path: out('echec-publication.png') });
    console.log((await p1.page.locator('body').innerText()).slice(0, 1500));
    throw error;
  });
const publish = p1.page.getByTestId('publish-dialog');
await publish.getByTestId('publish-shas').waitFor({ timeout: 60_000 });
await p1.page.screenshot({ path: out('p91-01-publication.png') });
await p1.page.getByTestId('publish-confirm').click();
await publish.getByTestId('publish-done').waitFor({ timeout: 180_000 });
await p1.page.getByRole('button', { name: 'Ouvrir l’espace PAMM' }).click();
await p1.page.waitForFunction(
  () => document.querySelector('[data-testid="workspace-select"]')?.value !== 'local',
);
await waitState(p1.page, 'synced', 180_000);
const plans = (await getJson(admin, '/api/plans')).plans;
const plan = plans.find((p) => p.name.startsWith('Circulation'));
const planPath = `#/camp/${plan.campId}/plan/${plan.id}`;
const serverPhoto = sha(await (await admin.get(`/api/files/${EXPECTED}`)).body());
log('1. Publié dans PAMM (pile Docker, HTTPS)', {
  plan: plan.name,
  versionServeur: plan.serverVersion,
  shaPhotoServeur: serverPhoto,
});

// 2. Ouvert par deux comptes autorisés -------------------------------------------------------------
const p2 = await computer('Poste 2');
await login(p2.page, 'edition@pamm.test');
await waitState(p2.page, 'synced', 180_000);
await p2.page.goto(`${APP}${planPath}`);
await p2.page.getByTestId('navigation-controls').waitFor({ timeout: 120_000 });
await p1.page.goto(`${APP}${planPath}`);
await p1.page.getByTestId('navigation-controls').waitFor({ timeout: 120_000 });
await waitState(p1.page, 'synced');
log('2. Ouvert par M. Gagnon (gestionnaire) et N. Tremblay (éditeur)');

// 3–4. Poste 1 hors ligne modifie ; poste 2 modifie la version serveur -----------------------------
await p1.context.setOffline(true);
await addLabel(p1.page, 520, 380, 'EXEMPLE — hors ligne (poste 1)');
await waitSaved(p1.page);
await waitState(p1.page, 'offline');
await p1.page.screenshot({ path: out('p91-03-hors-ligne.png') });
const before = (await getJson(admin, `/api/plans/${plan.id}`)).serverVersion;
await addLabel(p2.page, 900, 520, 'EXEMPLE — serveur (poste 2)');
await waitSaved(p2.page);
for (let i = 0; (await getJson(admin, `/api/plans/${plan.id}`)).serverVersion !== before + 1; i++) {
  if (i > 240) throw new Error('Modification du poste 2 absente du serveur.');
  await p2.page.waitForTimeout(250);
}
log('3-4. Hors ligne (poste 1) ; version serveur modifiée (poste 2)', { versionServeur: before + 1 });

// 5–6. Retour en ligne, conflit, deux versions conservées -----------------------------------------
await p1.context.setOffline(false);
await waitState(p1.page, 'conflict');
await p1.page.getByTestId('open-sync-conflict').click();
const conflict = p1.page.getByTestId('sync-conflict-dialog');
await conflict.waitFor();
await p1.page.screenshot({ path: out('p91-05-conflit.png') });
await conflict.getByTestId('conflict-copy-sync').click();
await conflict.waitFor({ state: 'hidden' });
await waitState(p1.page, 'synced', 120_000);
const after = (await getJson(admin, '/api/plans')).plans.filter((p) => p.name.startsWith('Circulation'));
log('5-6. Conflit détecté ; les deux versions conservées', {
  plans: after.map((p) => `${p.name} (v${p.serverVersion})`),
});

// 7–8. Compte désactivé ; ses requêtes refusées -----------------------------------------------------
const members = (await getJson(admin, '/api/members')).members;
const editor = members.find((m) => m.email === 'edition@pamm.test');
const disable = await admin.patch(`/api/members/${editor.id}`, {
  data: { status: 'disabled' },
  headers: CSRF,
});
const refused = await p2.page.request.get(`${APP}api/plans`);
const refusedLogin = await (
  await pwRequest.newContext({ baseURL: APP, ignoreHTTPSErrors: true, extraHTTPHeaders: CSRF })
).post('/api/auth/login', {
  data: { email: 'edition@pamm.test', password: passwords['edition@pamm.test'], deviceMode: 'trusted' },
});
await indicator(p2.page).click();
await p2.page.getByTestId('sync-now').click();
await p2.page.keyboard.press('Escape');
await waitState(p2.page, 'auth', 60_000);
await p2.page.screenshot({ path: out('p91-08-compte-desactive.png') });
log('7-8. Compte de N. Tremblay désactivé ; requêtes refusées', {
  desactivation: disable.status(),
  requeteSessionExistante: refused.status(),
  nouvelleConnexion: refusedLogin.status(),
  indicateurPoste2: await indicator(p2.page).getAttribute('data-state'),
});

// 9. Intégrité des révisions (instantanés et chaînage recalculés indépendamment) -------------------
const allRevisions = [];
for (const p of (await getJson(admin, '/api/plans')).plans) {
  const revs = (await getJson(admin, `/api/plans/${p.id}/revisions`)).revisions;
  let chain = '';
  for (const r of revs) {
    const full = await getJson(admin, `/api/revisions/${r.id}`);
    const snapshotOk = sha(Buffer.from(full.snapshot)) === full.meta.snapshot.sha256;
    const expectedChain = sha(Buffer.from(`${chain}|${full.meta.seal}`));
    allRevisions.push({
      plan: p.name,
      code: full.meta.label,
      instantané: snapshotOk,
      chaînage: expectedChain === full.chainHash,
    });
    chain = full.chainHash;
  }
}
log('9. Intégrité des révisions', {
  revisions: allRevisions,
  toutesIntègres: allRevisions.every((r) => r.instantané && r.chaînage),
});

// 10. Export .campplan depuis le poste 1 ------------------------------------------------------------
await p1.page.goto(`${APP}#/camp/${plan.campId}`);
const [download] = await Promise.all([
  p1.page.waitForEvent('download', { timeout: 120_000 }),
  p1.page.getByRole('button', { name: `Exporter ${plan.name} (.campplan)` }).click(),
]);
const exported = out('camp105-phase9-1-export.campplan');
await download.saveAs(exported);
const zip = unzipSync(new Uint8Array(readFileSync(exported)));
const exportedFiles = Object.entries(zip)
  .filter(([n]) => n.startsWith('fichiers/'))
  .map(([n, bytes]) => ({ fichier: n, sha256: sha(bytes) }));
log('10. Copie .campplan exportée', { fichier: exported, fichiers: exportedFiles });

// 11. Sauvegarde puis restauration sur un environnement de test ISOLÉ -------------------------------
const stamp = `camp105-${Date.now()}`;
const dc = (args, extra = '') =>
  execSync(`docker compose ${extra} -f docker-compose.yml ${args}`, {
    cwd: DEPLOY,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
execSync('mkdir -p backups && chmod 700 backups', { cwd: DEPLOY });
// Dossier des sauvegardes réservé au compte du conteneur (uid 1000), jamais lisible par tous.
dc('--profile ops run --rm --no-deps --user 0 --entrypoint chown ops 1000:1000 /backups');
const backupOut = dc(`--profile ops run --rm ops server/scripts/backup.ts backup --out /backups/${stamp}`);
const R = '-p campplanner-restauration';
dc('down -v', R);
dc('up -d db', R);
for (let i = 0; i < 60; i++) {
  try {
    dc('exec -T db pg_isready -U campplanner_owner -d campplanner', R);
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 2000));
  }
}
await new Promise((r) => setTimeout(r, 3000));
const restoreOut = dc(
  `--profile ops run --rm -v ${DEPLOY}/backups:/backups ops server/scripts/backup.ts restore --from /backups/${stamp}`,
  R,
);
execSync(`HTTPS_PORT=9443 HTTP_PORT=9088 docker compose ${R} -f docker-compose.yml up -d campplanner https`, {
  cwd: DEPLOY,
  stdio: 'ignore',
});
const restored = await pwRequest.newContext({
  baseURL: RESTORED,
  ignoreHTTPSErrors: true,
  extraHTTPHeaders: CSRF,
});
for (let i = 0; i < 60; i++) {
  const r = await restored.get('/api/health/ready').catch(() => null);
  if (r?.ok()) break;
  await new Promise((r2) => setTimeout(r2, 2000));
}
log('11. Sauvegarde + restauration isolée', {
  sauvegarde: backupOut.trim().split('\n').slice(-3),
  restauration: restoreOut.trim().split('\n').slice(-2),
});

// 12. Comparaison des SHA-256 --------------------------------------------------------------------
await restored.post('/api/auth/login', {
  data: { email: 'admin@pamm.test', password: ADMIN_PASSWORD, deviceMode: 'trusted' },
});
const restoredPhoto = sha(await (await restored.get(`/api/files/${EXPECTED}`)).body());
const restoredPlans = (await getJson(restored, '/api/plans')).plans;
const restoredRevs = [];
for (const p of restoredPlans)
  for (const r of (await getJson(restored, `/api/plans/${p.id}/revisions`)).revisions)
    restoredRevs.push({ id: r.id, chainHash: r.chainHash, verif: r.verificationType });
const origRevs = [];
for (const p of (await getJson(admin, '/api/plans')).plans)
  for (const r of (await getJson(admin, `/api/plans/${p.id}/revisions`)).revisions)
    origRevs.push({ id: r.id, chainHash: r.chainHash, verif: r.verificationType });
const photoAfter = sha(readFileSync(photo));
const exportPhoto = exportedFiles.find((f) => f.fichier.startsWith('fichiers/background-'))?.sha256;
log('12. Comparaison des SHA-256', {
  fichierOriginalAvant: photoBefore,
  fichierOriginalApres: photoAfter,
  serveur: serverPhoto,
  exportCampplan: exportPhoto,
  serveurRestaure: restoredPhoto,
  identiquePartout: [photoBefore, photoAfter, serverPhoto, exportPhoto, restoredPhoto].every(
    (s) => s === EXPECTED,
  ),
  plansOriginal: (await getJson(admin, '/api/plans')).plans.length,
  plansRestaures: restoredPlans.length,
  revisionsIdentiques:
    JSON.stringify(origRevs.sort((a, b) => a.id.localeCompare(b.id))) ===
    JSON.stringify(restoredRevs.sort((a, b) => a.id.localeCompare(b.id))),
});
// Captures : administration (compte désactivé, audit) sur la pile d'origine.
const adminUi = await computer('Admin');
await adminUi.page.goto(`${APP}#/connexion`);
await adminUi.page.getByLabel('Courriel').fill('admin@pamm.test');
await adminUi.page.getByLabel('Mot de passe').fill(ADMIN_PASSWORD);
await adminUi.page.getByTestId('device-mode').getByRole('radio').nth(0).check();
await adminUi.page.getByTestId('login-submit').click();
await adminUi.page.waitForFunction(() =>
  document.querySelector('[data-testid="workspace-select"]')?.value?.startsWith('org-'),
);
await adminUi.page.goto(`${APP}#/organisation`);
await adminUi.page.getByTestId('audit-row').first().waitFor();
await adminUi.page.screenshot({ path: out('p91-organisation-audit.png'), fullPage: true });
const audit = (await getJson(admin, '/api/audit?limit=200')).events.map(
  (e) => `${e.at} · ${e.userName ?? '—'} · ${e.action}`,
);
report.audit = audit;
report.erreursPage = errors;
writeFileSync(out('camp105-phase9-1-rapport.json'), JSON.stringify(report, null, 2));
execSync(`HTTPS_PORT=9443 HTTP_PORT=9088 docker compose ${R} -f docker-compose.yml down -v`, {
  cwd: DEPLOY,
  stdio: 'ignore',
});
await browser.close();
const ok =
  report.steps.at(-1).identiquePartout && report.steps.find((s) => s.step.startsWith('9.')).toutesIntègres;
console.log(ok ? 'Scénario final Camp 105 : réussi.' : 'Scénario final Camp 105 : ÉCART — voir le rapport.');
process.exit(ok ? 0 : 1);
