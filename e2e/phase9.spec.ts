/**
 * Phase 9 de bout en bout (application servie par le serveur CampPlanner, PostgreSQL temporaire) :
 * connexion et type d'appareil, hors ligne → retour en ligne, conflit entre deux ordinateurs,
 * appareil partagé (verrouillage, purge), approbation réelle + audit, publication d'un projet
 * local (approbation locale conservée « non vérifiée »), refus serveur visible.
 */
import { type Browser, type BrowserContext, type Page, expect, test } from '@playwright/test';
import {
  clickOnCanvas,
  createCamp,
  createPlan,
  fixture,
  importBackground,
  waitForBackground,
  waitSaved,
} from './helpers.ts';

const PASSWORD = 'mot-de-passe-solide-2026';
const unique = (name: string) => `${name} ${Math.random().toString(36).slice(2, 7)}`;

async function login(page: Page, email: string, mode: 'trusted' | 'shared' = 'trusted') {
  await page.goto('/#/connexion');
  await page.getByLabel('Courriel').fill(email);
  await page.getByLabel('Mot de passe').fill(PASSWORD);
  await page
    .getByTestId('device-mode')
    .getByRole('radio')
    .nth(mode === 'trusted' ? 0 : 1)
    .check();
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('workspace-bar')).toBeVisible();
  await expect(page.getByTestId('workspace-select')).toContainText('PAMM');
}

async function newContext(browser: Browser) {
  return browser.newContext({ baseURL: 'http://localhost:8787', viewport: { width: 1600, height: 1000 } });
}

async function label(page: Page, at: [number, number], text: string) {
  await page.keyboard.press('g');
  await clickOnCanvas(page, at);
  await page.getByTestId('text-editor').fill(text);
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
}

const indicator = (page: Page) => page.getByTestId('sync-indicator').first();
const expectSynced = (page: Page, timeout = 30_000) =>
  expect(indicator(page)).toHaveAttribute('data-state', 'synced', { timeout });

async function campWithPhoto(page: Page, camp: string) {
  await createCamp(page, camp);
  await createPlan(page, 'Circulation');
  await importBackground(page, fixture('quadrants.png'));
  await waitForBackground(page);
  await waitSaved(page);
  await expectSynced(page);
  return page.url();
}

const planIdOf = (url: string) => url.split('/plan/')[1]!;

test.describe('Phase 9 — comptes, organisation, synchronisation', () => {
  test('connexion : le type d’appareil est obligatoire ; espace PAMM ; état synchronisé', async ({
    page,
  }) => {
    await page.goto('/#/connexion');
    await page.getByLabel('Courriel').fill('gestion@pamm.test');
    await page.getByLabel('Mot de passe').fill(PASSWORD);
    await page.getByTestId('login-submit').click();
    await expect(page.getByRole('alert')).toContainText('Choisissez le type d’appareil');
    await expect(page.getByTestId('device-mode')).toContainText(
      'des données de l’organisation restent stockées',
    );
    await page.screenshot({ path: test.info().outputPath('connexion.png') });
    await login(page, 'gestion@pamm.test');
    await expect(page.getByTestId('workspace-select')).toContainText('M. Gagnon');
    await expectSynced(page);
  });

  test('hors ligne : on continue à travailler ; retour en ligne : tout est envoyé, rien de perdu', async ({
    page,
    context,
  }) => {
    await login(page, 'gestion@pamm.test');
    const url = await campWithPhoto(page, unique('Camp hors ligne'));
    await context.setOffline(true);
    await label(page, [300, 300], 'HORS-LIGNE-1');
    await label(page, [500, 300], 'HORS-LIGNE-2');
    await waitSaved(page);
    await expect(indicator(page)).toHaveAttribute('data-state', /offline|local-changes/, { timeout: 15_000 });
    await page.screenshot({ path: test.info().outputPath('hors-ligne.png') });
    await context.setOffline(false);
    await expectSynced(page);
    const server = await page.request.get(`/api/plans/${planIdOf(url)}`);
    const texts = Object.values(
      (await server.json()).document.objects as Record<string, { text?: string }>,
    ).map((o) => o.text);
    expect(texts).toEqual(expect.arrayContaining(['HORS-LIGNE-1', 'HORS-LIGNE-2']));
  });

  test('conflit entre deux ordinateurs : détecté, rien d’écrasé, les deux versions conservées', async ({
    browser,
  }) => {
    const a = await newContext(browser);
    const b = await newContext(browser);
    const pa = await a.newPage();
    const pb = await b.newPage();
    await login(pa, 'gestion@pamm.test');
    const camp = unique('Camp conflit');
    const url = await campWithPhoto(pa, camp);
    await expectSynced(pa);
    // Second ordinateur : ouvre le même plan (reçu du serveur).
    await login(pb, 'edition@pamm.test');
    await expect(pb.getByRole('link', { name: new RegExp(camp) })).toBeVisible({ timeout: 30_000 });
    await pb.goto(url.replace('http://localhost:8787', ''));
    await waitForBackground(pb);
    // A hors ligne modifie ; B modifie en ligne.
    await a.setOffline(true);
    await label(pa, [300, 300], 'VERSION-A');
    await waitSaved(pa);
    await label(pb, [600, 300], 'VERSION-B');
    await waitSaved(pb);
    // La version de B est sur le serveur AVANT que A revienne en ligne.
    await expect
      .poll(
        async () => {
          const json = (await (await pb.request.get(`/api/plans/${planIdOf(url)}`)).json()) as {
            document: { objects: Record<string, { text?: string }> };
          };
          return Object.values(json.document.objects).some((o) => o.text === 'VERSION-B');
        },
        { timeout: 30_000 },
      )
      .toBe(true);
    await a.setOffline(false);
    await expect(indicator(pa)).toHaveAttribute('data-state', 'conflict', { timeout: 30_000 });
    await pa.getByTestId('open-sync-conflict').click();
    const dialog = pa.getByTestId('sync-conflict-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId('conflict-theirs')).toContainText('N. Tremblay');
    await pa.screenshot({ path: test.info().outputPath('conflit.png') });
    await dialog.getByTestId('conflict-copy-sync').click();
    await expect(dialog).toBeHidden();
    await expectSynced(pa);
    await pa.goto(`/#/camp/${url.split('/camp/')[1]!.split('/')[0]}`);
    await expect(pa.getByTestId('plan-row')).toHaveCount(2);
    const plans = (await (await pa.request.get('/api/plans')).json()).plans as { name: string }[];
    expect(plans.filter((p) => p.name.startsWith('Circulation')).length).toBeGreaterThanOrEqual(2);
    await a.close();
    await b.close();
  });

  test('appareil partagé : verrouillé sans session dans cet onglet ; déconnexion = données supprimées', async ({
    page,
    context,
  }) => {
    await login(page, 'gestion@pamm.test', 'shared');
    const camp = unique('Camp partagé');
    await createCamp(page, camp);
    await page.goto('/#/');
    await expectSynced(page);
    // Nouvel onglet (session du navigateur non authentifiée pour cet onglet) : aucun projet visible.
    const other = await context.newPage();
    await other.goto('/#/');
    await expect(other.getByTestId('locked-screen')).toBeVisible();
    await expect(other.getByText(camp)).toHaveCount(0);
    await other.close();
    await page.getByTestId('logout').click();
    await page.getByTestId('logout-confirm').click();
    await expect(page.getByTestId('workspace-select')).toHaveValue('local');
    const dbs = await page.evaluate(async () => (await indexedDB.databases()).map((d) => d.name));
    expect(dbs.some((n) => n?.startsWith('campplanner-') && n !== 'campplanner')).toBe(false);
  });

  test('approbation réelle : compte connecté, date serveur, badge vérifié, journal d’audit', async ({
    page,
  }) => {
    await login(page, 'gestion@pamm.test');
    await campWithPhoto(page, unique('Camp approbation'));
    await page.getByRole('tab', { name: 'Révisions' }).click();
    await page.getByTestId('create-revision').click();
    await page.getByTestId('create-revision-dialog').getByLabel('Auteur').fill('M. Gagnon');
    await page.getByTestId('confirm-create-revision').click();
    await expectSynced(page);
    await page.getByRole('button', { name: 'Statut…' }).click();
    const status = page.getByTestId('status-dialog');
    await status.getByLabel('Nouveau statut').selectOption({ label: 'Approuvé' });
    await expect(status.getByLabel('Compte connecté (identité vérifiée par le serveur)')).toHaveValue(
      'M. Gagnon',
    );
    await status.getByLabel('Je confirme être autorisé(e) à approuver cette révision.').check();
    await page.getByTestId('confirm-status').click();
    await expect(page.getByTestId('approval-verification')).toHaveAttribute(
      'data-verification',
      'authenticated_server',
    );
    await page.goto('/#/organisation');
    await expect(
      page.locator('[data-testid="audit-row"][data-action="revision.approve"]').first(),
    ).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('audit.png'), fullPage: true });
  });

  test('publication d’un projet local : récapitulatif, approbation locale conservée « non vérifiée »', async ({
    page,
  }) => {
    // 1. Projet local (espace sans compte) avec une révision approuvée localement (déclarée).
    await page.goto('/#/');
    const camp = unique('Camp local');
    await createCamp(page, camp);
    await createPlan(page, 'Plan local');
    await importBackground(page, fixture('quadrants.png'));
    await waitForBackground(page);
    await waitSaved(page);
    await page.getByRole('tab', { name: 'Révisions' }).click();
    await page.getByTestId('create-revision').click();
    await page.getByTestId('create-revision-dialog').getByLabel('Auteur').fill('Chef de camp');
    await page.getByTestId('confirm-create-revision').click();
    await page.getByRole('button', { name: 'Statut…' }).click();
    const status = page.getByTestId('status-dialog');
    await status.getByLabel('Nouveau statut').selectOption({ label: 'Approuvé' });
    await status.getByLabel('Approbateur (nom)').fill('Chef de camp (déclaré)');
    await status.getByLabel('Je confirme être autorisé(e) à approuver cette révision.').check();
    await page.getByTestId('confirm-status').click();
    await expect(page.getByTestId('approval-verification')).toHaveAttribute(
      'data-verification',
      'local_unverified',
    );
    // 2. Connexion (crée l'espace PAMM), retour à l'espace local, publication.
    await login(page, 'gestion@pamm.test');
    await page.getByTestId('workspace-select').selectOption('local');
    await expect(page.getByText(camp)).toBeVisible();
    await page.getByRole('button', { name: `Publier dans l’organisation : ${camp}` }).click();
    const dialog = page.getByTestId('publish-dialog');
    await expect(dialog.getByTestId('publish-summary')).toContainText('Plans : 1');
    await expect(dialog.getByTestId('publish-unverified')).toContainText('1');
    await expect(dialog.getByTestId('publish-shas')).toContainText('SHA-256');
    await page.getByTestId('publish-confirm').click();
    await expect(dialog.getByTestId('publish-done')).toBeVisible({ timeout: 60_000 });
    await page.getByRole('button', { name: 'Ouvrir l’espace PAMM' }).click();
    await expect(page.getByTestId('workspace-select')).toContainText('PAMM');
    await page.getByRole('link', { name: new RegExp(camp) }).click();
    await page.getByRole('link', { name: /Plan local/ }).click();
    await waitForBackground(page);
    await page.getByRole('tab', { name: 'Révisions' }).click();
    await expect(page.getByTestId('approval-verification')).toHaveAttribute(
      'data-verification',
      'local_unverified',
    );
    await expect(page.getByTestId('approval-verification')).toContainText('identité non vérifiée');
  });

  test('refus du serveur (lecteur qui modifie) : « Erreur de synchro » visible, rien de perdu localement', async ({
    browser,
  }) => {
    const m = await newContext(browser);
    const pm = await m.newPage();
    await login(pm, 'gestion@pamm.test');
    const url = await campWithPhoto(pm, unique('Camp lecteur'));
    const r: BrowserContext = await newContext(browser);
    const pr = await r.newPage();
    await login(pr, 'lecture@pamm.test');
    await expectSynced(pr);
    await pr.goto(url.replace('http://localhost:8787', ''));
    await waitForBackground(pr);
    await label(pr, [400, 300], 'LECTEUR');
    await waitSaved(pr);
    await expect(indicator(pr)).toHaveAttribute('data-state', 'error', { timeout: 30_000 });
    await indicator(pr).click();
    await expect(pr.getByTestId('sync-queue').locator('[data-status="failed"]')).toContainText('rôle');
    await m.close();
    await r.close();
  });
});
