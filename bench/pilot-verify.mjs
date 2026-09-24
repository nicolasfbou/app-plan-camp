/**
 * Déploiement pilote — vérifications APRÈS déploiement, dans de vrais navigateurs (Chromium) :
 *   1 adresse publique · 2 ouverture de l'application · 3 connexion · 4 création d'un camp ·
 *   5 import de la photo aérienne · 6 édition d'un plan · 7 enregistrement · 8 rechargement ·
 *   9 export PDF · 10 synchronisation · 11 réouverture depuis un deuxième navigateur ;
 *   12 (si PILOT_DEMO=<fichier .campplan>) projet de démonstration importé dans PAMM, conservé.
 *
 *   PILOT_URL=https://… PILOT_EMAIL=… PILOT_PASSWORD=… \
 *     node bench/pilot-verify.mjs <photo> <dossier-sortie>
 *
 * - Compte d'ESSAI conseillé (invité par l'administrateur, désactivé ensuite) : le mot de passe
 *   n'est lu que dans l'environnement, jamais affiché, jamais dans une capture (aucune capture
 *   n'est prise pendant la saisie).
 * - La photo est seulement LUE (SHA-256 vérifié avant, après, et relu sur le serveur).
 * - Données d'essai : un camp « ESSAI PILOTE … », supprimé à la fin (suppression logique, tracée
 *   dans l'audit) sauf si PILOT_KEEP=1.
 * - PILOT_IGNORE_TLS=1 : uniquement pour la simulation locale (certificat interne).
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { chromium, expect } from '@playwright/test';

const [photo, outDir] = process.argv.slice(2);
const BASE = (process.env.PILOT_URL ?? '').replace(/\/$/, '');
const EMAIL = process.env.PILOT_EMAIL;
const PASSWORD = process.env.PILOT_PASSWORD;
if (!photo || !outDir || !BASE || !EMAIL || !PASSWORD)
  throw new Error(
    'Usage : PILOT_URL=… PILOT_EMAIL=… PILOT_PASSWORD=… node bench/pilot-verify.mjs <photo> <dossier>',
  );
mkdirSync(outDir, { recursive: true });
const sha = (b) => createHash('sha256').update(b).digest('hex');
const photoBytes = readFileSync(photo);
const photoBefore = sha(photoBytes);
const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
const CAMP = `ESSAI PILOTE ${stamp}`;
const LABEL = `ESSAI-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
const results = [];
const step = async (name, fn) => {
  const started = Date.now();
  try {
    const detail = (await fn()) ?? {};
    results.push({ étape: name, ok: true, ms: Date.now() - started, ...detail });
    console.log(`✓ ${name}`);
  } catch (error) {
    results.push({ étape: name, ok: false, erreur: String(error?.message ?? error).split('\n')[0] });
    console.log(`✗ ${name} : ${String(error?.message ?? error).split('\n')[0]}`);
    throw error;
  }
};
const shot = (page, name) => page.screenshot({ path: join(outDir, name) });

const browser = await chromium.launch({
  ...(process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {}),
});
const options = {
  baseURL: BASE,
  viewport: { width: 1600, height: 1000 },
  ignoreHTTPSErrors: process.env.PILOT_IGNORE_TLS === '1',
  acceptDownloads: true,
};
const errors = [];
const watch = (page, who) => page.on('pageerror', (e) => errors.push(`${who} : ${e.message}`));

async function login(page) {
  await page.goto('/#/connexion');
  await page.getByLabel('Courriel').fill(EMAIL);
  await page.getByLabel('Mot de passe').fill(PASSWORD);
  await page.getByTestId('device-mode').getByRole('radio').nth(0).check(); // appareil de confiance
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('workspace-bar')).toBeVisible({ timeout: 30_000 });
  // Le champ du mot de passe n'est plus affiché : les captures suivantes sont sans risque.
  await expect(page.getByLabel('Mot de passe')).toHaveCount(0);
}
async function synced(page, timeout = 60_000) {
  const ind = page.getByTestId('sync-indicator').first();
  await expect(ind).toHaveAttribute('data-state', 'synced', { timeout });
  await expect(ind).toHaveAttribute('data-syncing', 'false', { timeout });
  await expect(ind).toHaveAttribute('data-pending', '0', { timeout });
}
const hasLabel = (page, text) =>
  page.evaluate((t) => {
    const stage = window.Konva?.stages?.[0];
    return Boolean(stage?.find('Text').some((n) => n.text() === t));
  }, text);

let planUrl = '';
let planId = '';
let campId = '';
const a = await browser.newContext(options);
const pa = await a.newPage();
watch(pa, 'navigateur 1');
try {
  await step('1. Adresse publique (HTTPS, contrôle de santé)', async () => {
    const r = await pa.request.get('/api/health/ready');
    expect(r.status()).toBe(200);
    return { adresse: BASE, sante: await r.json(), https: BASE.startsWith('https://') };
  });
  await step('2. Ouverture de l’application', async () => {
    await pa.goto('/');
    await expect(pa).toHaveTitle(/CampPlanner/);
    await shot(pa, 'pilote-01-ouverture.png');
  });
  await step('3. Connexion', async () => {
    await login(pa);
    await expect(pa.getByTestId('workspace-select')).toContainText(/PAMM/);
    await synced(pa);
    await shot(pa, 'pilote-02-connecte.png');
  });
  await step('4. Création d’un camp', async () => {
    await pa.getByRole('button', { name: 'Nouveau camp' }).click();
    await pa.getByLabel('Nom du camp').fill(CAMP);
    await pa.getByRole('button', { name: 'Créer' }).click();
    await expect(pa.getByRole('heading', { name: CAMP, exact: true })).toBeVisible();
    await pa.getByRole('button', { name: 'Nouveau plan' }).click();
    await pa.getByLabel('Nom du plan').fill('Plan d’essai — EXEMPLE ILLUSTRATIF — À VALIDER SUR LE TERRAIN');
    await pa.getByRole('button', { name: 'Créer' }).click();
    await expect(pa.getByTestId('plan-title')).toContainText('Plan d’essai');
    return { camp: CAMP };
  });
  await step('5. Import de la photo aérienne', async () => {
    await pa.getByTestId('import-input').setInputFiles(photo);
    await expect(pa.getByTestId('navigation-controls')).toBeVisible({ timeout: 60_000 });
    planUrl = pa.url();
    planId = planUrl.split('/plan/')[1];
    campId = planUrl.split('/camp/')[1].split('/')[0];
    return { fichier: basename(photo), octets: photoBytes.length };
  });
  await step('6. Édition du plan (texte ajouté sur la photo)', async () => {
    await pa.keyboard.press('g');
    const box = await pa.getByTestId('canvas-container').boundingBox();
    await pa.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await pa.getByTestId('text-editor').fill(LABEL);
    await pa.keyboard.press('Enter');
    await pa.keyboard.press('Escape');
    expect(await hasLabel(pa, LABEL)).toBe(true);
  });
  await step('7. Enregistrement', async () => {
    await expect(pa.getByTestId('save-status')).toHaveText('Enregistré', { timeout: 20_000 });
    await shot(pa, 'pilote-03-plan-edite.png');
  });
  await step('8. Rechargement de la page', async () => {
    await pa.reload();
    await expect(pa.getByTestId('navigation-controls')).toBeVisible({ timeout: 60_000 });
    await expect.poll(() => hasLabel(pa, LABEL), { timeout: 20_000 }).toBe(true);
  });
  await step('9. Export PDF', async () => {
    await pa.getByTestId('open-print').click();
    await expect(pa.getByTestId('print-dialog')).toBeVisible();
    const [download] = await Promise.all([
      pa.waitForEvent('download', { timeout: 120_000 }),
      pa.getByTestId('print-export').click(),
    ]);
    const bytes = readFileSync(await download.path());
    expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
    writeFileSync(join(outDir, 'pilote-export.pdf'), bytes);
    await pa.keyboard.press('Escape');
    return { fichier: download.suggestedFilename(), octets: bytes.length };
  });
  await step('10. Synchronisation avec le serveur', async () => {
    await synced(pa);
    const plan = await (await pa.request.get(`/api/plans/${planId}`)).json();
    const texts = Object.values(plan.document.objects).map((o) => o.text);
    expect(texts).toContain(LABEL);
    const background = plan.document.plan.baseImage.sha256;
    const served = await pa.request.get(`/api/files/${background}`);
    expect(served.status()).toBe(200);
    const servedSha = sha(await served.body());
    expect(servedSha).toBe(photoBefore);
    return { versionServeur: plan.serverVersion, shaPhotoServeur: servedSha };
  });
  await step('11. Réouverture depuis un deuxième navigateur', async () => {
    const b = await browser.newContext(options);
    const pb = await b.newPage();
    watch(pb, 'navigateur 2');
    await login(pb);
    await synced(pb);
    await expect(pb.getByRole('link', { name: new RegExp(CAMP) })).toBeVisible({ timeout: 30_000 });
    await pb.goto(planUrl.replace(BASE, ''));
    await expect(pb.getByTestId('navigation-controls')).toBeVisible({ timeout: 60_000 });
    await expect.poll(() => hasLabel(pb, LABEL), { timeout: 30_000 }).toBe(true);
    await shot(pb, 'pilote-04-deuxieme-navigateur.png');
    await b.close();
  });
  if (process.env.PILOT_DEMO)
    await step('12. Projet de démonstration Camp 105 importé dans PAMM (conservé)', async () => {
      await pa.goto('/#/');
      await pa.getByTestId('campplan-input').setInputFiles(process.env.PILOT_DEMO);
      await expect(pa.getByTestId('import-verified')).toBeVisible({ timeout: 60_000 });
      await pa.getByRole('button', { name: 'Importer', exact: true }).click();
      await expect(pa.getByTestId('navigation-controls')).toBeVisible({ timeout: 60_000 });
      await expect(pa.getByTestId('plan-title')).toContainText(
        'EXEMPLE ILLUSTRATIF — À VALIDER SUR LE TERRAIN',
      );
      await synced(pa);
      const id = pa.url().split('/plan/')[1];
      const plan = await (await pa.request.get(`/api/plans/${id}`)).json();
      const tb = plan.document.plan.titleBlock;
      expect(tb.status).not.toBe('approved');
      expect(tb.approvedAt).toBeNull();
      expect(plan.document.plan.northStatus).toBe('undefined');
      expect(plan.document.plan.calibration).toBeNull();
      const served = sha(
        await (await pa.request.get(`/api/files/${plan.document.plan.baseImage.sha256}`)).body(),
      );
      expect(served).toBe(photoBefore);
      await shot(pa, 'pilote-05-demonstration.png');
      return { plan: plan.document.plan.name, statut: tb.status, shaPhotoServeur: served };
    });
} finally {
  if (process.env.PILOT_KEEP !== '1' && campId) {
    // Nettoyage : suppression logique (restaurable, tracée dans l'audit).
    const headers = { 'x-campplanner': '1' };
    const p = await (await pa.request.get(`/api/plans/${planId}`)).json().catch(() => null);
    if (p?.serverVersion)
      await pa.request.delete(`/api/plans/${planId}`, {
        headers: { ...headers, 'if-match': String(p.serverVersion) },
      });
    const camps = (await (await pa.request.get('/api/camps')).json().catch(() => ({ camps: [] }))).camps;
    const c = camps.find((x) => x.id === campId);
    if (c)
      await pa.request.delete(`/api/camps/${campId}`, {
        headers: { ...headers, 'if-match': String(c.serverVersion) },
      });
  }
  await browser.close();
  const report = {
    adresse: BASE,
    compte: EMAIL,
    date: new Date().toISOString(),
    photo: { avant: photoBefore, apres: sha(readFileSync(photo)) },
    etapes: results,
    erreursPage: errors,
    nettoyage: process.env.PILOT_KEEP === '1' ? 'conservé' : 'camp et plan d’essai supprimés (logiquement)',
  };
  writeFileSync(join(outDir, 'pilote-verification.json'), JSON.stringify(report, null, 2));
  const expected = process.env.PILOT_DEMO ? 12 : 11;
  const ok =
    results.length === expected && results.every((r) => r.ok) && report.photo.avant === report.photo.apres;
  console.log(
    ok
      ? `Vérification pilote : ${expected}/${expected} réussies.`
      : 'Vérification pilote : ÉCHEC — voir le rapport.',
  );
  process.exitCode = ok ? 0 : 1;
}
