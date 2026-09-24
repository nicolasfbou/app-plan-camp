/**
 * Phase 9 de bout en bout (application servie par le serveur CampPlanner, PostgreSQL temporaire) :
 * connexion et type d'appareil, hors ligne → retour en ligne, conflit entre deux ordinateurs,
 * appareil partagé (verrouillage, purge), approbation réelle + audit, publication d'un projet
 * local (approbation locale conservée « non vérifiée »), refus serveur visible.
 */
import { type BrowserContext, expect, test } from '@playwright/test';
import {
  createCamp,
  createPlan,
  fixture,
  importBackground,
  waitForBackground,
  waitSaved,
} from './helpers.ts';
import {
  campWithPhoto,
  expectSynced,
  indicator,
  label,
  login,
  newContext,
  PASSWORD,
  planIdOf,
  unique,
} from './server.ts';

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
    // Point de synchronisation : premier cycle COMPLET de B terminé → plan reçu à sa dernière
    // version (jamais de navigation vers un plan pas encore arrivé).
    await expectSynced(pb);
    await expect(pb.getByRole('link', { name: new RegExp(camp) })).toBeVisible();
    await pb.goto(url.replace('http://localhost:8787', ''));
    await waitForBackground(pb);
    const baseVersion = (await (await pb.request.get(`/api/plans/${planIdOf(url)}`)).json()).serverVersion;
    // A : aucune requête en vol au moment de la coupure.
    await expectSynced(pa);
    // A hors ligne modifie ; B modifie en ligne.
    await a.setOffline(true);
    await label(pa, [300, 300], 'VERSION-A');
    await waitSaved(pa);
    await label(pb, [600, 300], 'VERSION-B');
    await waitSaved(pb);
    // Point de synchronisation : la version de B est sur le serveur (B entièrement synchronisé,
    // version serveur avancée d'exactement un envoi, contenu vérifié) AVANT le retour de A.
    // (Condition interrogée, pas une durée : l'indicateur de B peut ne pas encore refléter l'envoi.)
    const serverPlan = async () =>
      (await (await pb.request.get(`/api/plans/${planIdOf(url)}`)).json()) as {
        serverVersion: number;
        document: { objects: Record<string, { text?: string }> };
      };
    await expect
      .poll(async () => (await serverPlan()).serverVersion, { timeout: 30_000 })
      .toBe(baseVersion + 1);
    const server = await serverPlan();
    expect(Object.values(server.document.objects).some((o) => o.text === 'VERSION-B')).toBe(true);
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

  test('appareil partagé fermé sans déconnexion : écran verrouillé, effacement possible sans session', async ({
    page,
    context,
  }) => {
    await login(page, 'gestion@pamm.test', 'shared');
    const camp = unique('Camp oublié');
    await createCamp(page, camp);
    await page.goto('/#/');
    await expectSynced(page);
    await page.close(); // navigateur fermé de force : aucune déconnexion
    const next = await context.newPage();
    await next.goto('/#/');
    await expect(next.getByTestId('locked-screen')).toBeVisible();
    await expect(next.getByText(camp)).toHaveCount(0);
    next.on('dialog', (d) => void d.accept());
    await next.getByTestId('erase-device').click();
    await expect(next.getByTestId('workspace-select')).toHaveValue('local');
    const dbs = await next.evaluate(async () => (await indexedDB.databases()).map((d) => d.name));
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
