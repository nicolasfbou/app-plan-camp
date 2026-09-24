/**
 * Phase 9.1 — déconnexion, révocation et données locales (navigateur réel + serveur réel) :
 * - poste partagé, plusieurs onglets : la déconnexion ferme les autres onglets ; un onglet
 *   « figé » (qui ne reçoit pas le message) ne peut pas recréer durablement les données ;
 * - poste partagé hors ligne : déconnexion suspendue, effacement explicite, session serveur
 *   fermée au retour du réseau ;
 * - invitation d'un compte existant : devinette de mot de passe bloquée (interface) ;
 * - compte suspendu : ses requêtes sont refusées ; poste partagé verrouillé immédiatement.
 */
import { expect, test } from '@playwright/test';
import { createCamp } from './helpers.ts';
import {
  campWithPhoto,
  expectSynced,
  label,
  login,
  newContext,
  orgDatabases,
  PASSWORD,
  SERVER,
  unique,
} from './server.ts';

const CSRF = { 'X-CampPlanner': '1' };

test.describe('Phase 9.1 — déconnexion, révocation, données locales', () => {
  test('poste partagé, trois onglets : déconnexion → autres onglets fermés ; onglet figé : rien de durable recréé', async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    const ctx = await newContext(browser);
    const p1 = await ctx.newPage();
    await login(p1, 'gestion@pamm.test', 'shared');
    const camp = unique('Camp multi-onglets');
    const planUrl = await campWithPhoto(p1, camp);
    await p1.goto('/#/');
    await expectSynced(p1);
    const { profileId, dbName } = await p1.evaluate(() => {
      const id = localStorage.getItem('campplanner.activeProfile')!;
      const profiles = JSON.parse(localStorage.getItem('campplanner.profiles')!) as {
        id: string;
        dbName: string;
      }[];
      return { profileId: id, dbName: profiles.find((p) => p.id === id)!.dbName };
    });
    // Onglet 2 : dupliqué depuis l'onglet 1 (hérite de son déverrouillage), ouvert sur le plan.
    const [p2] = await Promise.all([
      ctx.waitForEvent('page'),
      p1.evaluate((u) => window.open(u, '_blank'), planUrl),
    ]);
    await expect(p2.getByTestId('navigation-controls')).toBeVisible({ timeout: 30_000 });
    // Onglet 3 : « figé » — ne reçoit AUCUN signal (ni message entre onglets, ni évènement
    // « storage ») : pire cas, ouvert sur le plan.
    const p3 = await ctx.newPage();
    await p3.addInitScript(
      ({ id }) => {
        sessionStorage.setItem(`campplanner.unlocked.${id}`, '1');
        (window as unknown as { BroadcastChannel?: unknown }).BroadcastChannel = undefined;
        const add = window.addEventListener.bind(window);
        window.addEventListener = ((type: string, ...rest: unknown[]) => {
          if (type !== 'storage') (add as (...a: unknown[]) => void)(type, ...rest);
        }) as typeof window.addEventListener;
      },
      { id: profileId },
    );
    await p3.goto(planUrl);
    await expect(p3.getByTestId('navigation-controls')).toBeVisible({ timeout: 30_000 });
    expect(await orgDatabases(p1)).toContain(dbName);
    await p2.evaluate(() => ((window as unknown as { __avant: number }).__avant = 1));

    // Traces personnelles hors de la base (journal d'erreurs, nom d'auteur de révision).
    await p1.evaluate(() => {
      localStorage.setItem('campplanner.errorLog', '[{"message":"plan PAMM"}]');
      localStorage.setItem('campplanner.revisionAuthor', 'Personne A');
    });
    // Déconnexion dans l'onglet 1.
    await p1.getByTestId('logout').click();
    await p1.getByTestId('logout-confirm').click();
    await expect(p1.getByTestId('workspace-select')).toHaveValue('local');
    expect(
      await p1.evaluate(() => [
        localStorage.getItem('campplanner.errorLog'),
        localStorage.getItem('campplanner.revisionAuthor'),
      ]),
    ).toEqual([null, null]);
    // Onglet 2 : base fermée pour de bon, page rechargée (marqueur disparu) sur l'espace local.
    await expect
      .poll(() => p2.evaluate(() => (window as unknown as { __avant?: number }).__avant ?? 0), {
        timeout: 15_000,
      })
      .toBe(0);
    await p2.goto('/#/');
    await expect(p2.getByTestId('workspace-select')).toHaveValue('local');
    await expect(p2.getByText(camp)).toHaveCount(0);
    // Onglet 3 (figé) : il tente encore de modifier le plan qu'il avait en mémoire. Deux issues
    // acceptables : son propre moteur de synchronisation voit la session refusée et verrouille
    // l'espace (rechargement), OU l'écriture locale est refusée. Jamais de donnée réécrite.
    const lateWrite =
      (await p3.getByTestId('canvas-container').isVisible()) &&
      (await label(p3, [400, 300], 'ÉCRITURE TARDIVE').then(
        () => true,
        () => false,
      ));
    if (lateWrite)
      await expect(p3.getByTestId('save-status')).not.toHaveText('Enregistré', { timeout: 10_000 });
    // … l'écriture locale est refusée (aucune donnée réécrite), aucun journal de récupération
    // n'est écrit pour l'espace effacé, et le serveur refuse tout (session révoquée).
    const journals = () =>
      p3.evaluate((db) => Object.keys(localStorage).filter((k) => k.includes(db)), dbName);
    expect(await journals()).toEqual([]);
    const refused = await p3.request.get('/api/plans');
    expect(refused.status()).toBe(401);
    const planRows = await p3.evaluate(
      (db) =>
        new Promise<number>((resolve) => {
          const open = indexedDB.open(db);
          open.onsuccess = () => {
            const names = Array.from(open.result.objectStoreNames);
            if (!names.includes('plans')) return resolve(0);
            const r = open.result.transaction('plans').objectStore('plans').count();
            r.onsuccess = () => resolve(r.result);
          };
          open.onerror = () => resolve(0);
        }),
      dbName,
    );
    expect(planRows).toBe(0);
    // Au rechargement (ou à l'ouverture de n'importe quel onglet), la base recréée est effacée :
    // aucune donnée de l'organisation ne subsiste dans le navigateur.
    await p3.goto('/#/');
    await p3.reload();
    await expect(p3.getByTestId('workspace-select')).toHaveValue('local');
    await expect.poll(() => orgDatabases(p3), { timeout: 15_000 }).toEqual([]);
    expect(await journals()).toEqual([]);
    await expect(p3.getByText(camp)).toHaveCount(0);
    await ctx.close();
  });

  test('poste partagé hors ligne : déconnexion suspendue, effacement explicite ; session serveur fermée au retour du réseau', async ({
    browser,
  }) => {
    const ctx = await newContext(browser);
    const page = await ctx.newPage();
    await login(page, 'gestion@pamm.test', 'shared');
    const camp = unique('Camp hors ligne partagé');
    await createCamp(page, camp);
    await page.goto('/#/');
    await expectSynced(page);
    await ctx.setOffline(true);
    await page.getByTestId('logout').click();
    await page.getByTestId('logout-confirm').click();
    // Serveur injoignable : rien n'est effacé en silence ; la personne est prévenue.
    await expect(page.getByTestId('logout-dialog').getByRole('alert')).toContainText('Serveur injoignable');
    await expect(page.getByTestId('logout-confirm')).toContainText('Effacer quand même');
    expect(await orgDatabases(page)).toHaveLength(1);
    // Second choix explicite : données locales effacées.
    await page.getByTestId('logout-confirm').click();
    await expect(page.getByTestId('workspace-select')).toHaveValue('local');
    expect(await orgDatabases(page)).toEqual([]);
    expect(await page.evaluate(() => localStorage.getItem('campplanner.pendingLogout'))).toBe('1');
    // Retour du réseau : la session serveur (cookie encore présent) est fermée automatiquement.
    await ctx.setOffline(false);
    await expect
      .poll(async () => (await page.request.get('/api/auth/me')).status(), { timeout: 15_000 })
      .toBe(401);
    expect(await page.evaluate(() => localStorage.getItem('campplanner.pendingLogout'))).toBeNull();
    await ctx.close();
  });

  test('invitation d’un compte existant : 5 mots de passe faux → invitation bloquée, même avec le bon ensuite', async ({
    browser,
    playwright,
  }) => {
    const adminB = await playwright.request.newContext({ baseURL: SERVER, extraHTTPHeaders: CSRF });
    expect(
      (
        await adminB.post('/api/auth/login', {
          data: { email: 'admin@autre.test', password: PASSWORD, deviceMode: 'trusted' },
        })
      ).status(),
    ).toBe(200);
    const inv = await (
      await adminB.post('/api/invitations', { data: { email: 'cible@pamm.test', role: 'reader' } })
    ).json();
    const ctx = await newContext(browser);
    const page = await ctx.newPage();
    await page.goto(`/#/invitation/${inv.token}`);
    for (let i = 0; i < 5; i++) {
      await page.getByLabel('Mot de passe').fill(`essai-faux-${i}`);
      await page.getByRole('button', { name: 'Rejoindre' }).click();
      await expect(page.getByRole('alert')).toContainText('incorrect');
    }
    await page.getByLabel('Mot de passe').fill(PASSWORD);
    await page.getByRole('button', { name: 'Rejoindre' }).click();
    await expect(page.getByRole('alert')).toContainText('Invitation invalide');
    await page.reload();
    await expect(page.getByText('Invitation invalide')).toBeVisible();
    const audit = (await (await adminB.get('/api/audit?limit=50')).json()).events as { action: string }[];
    expect(audit.some((e) => e.action === 'member.invite.locked')).toBe(true);
    await adminB.dispose();
    await ctx.close();
  });

  test('compte suspendu pendant l’utilisation : requêtes refusées ; poste partagé verrouillé immédiatement', async ({
    browser,
    playwright,
  }) => {
    const ctx = await newContext(browser);
    const page = await ctx.newPage();
    await login(page, 'suspendu@pamm.test', 'shared');
    await expectSynced(page);
    const admin = await playwright.request.newContext({ baseURL: SERVER, extraHTTPHeaders: CSRF });
    await admin.post('/api/auth/login', {
      data: { email: 'admin@pamm.test', password: PASSWORD, deviceMode: 'trusted' },
    });
    const me = await (await page.request.get('/api/auth/me')).json();
    expect((await admin.patch(`/api/members/${me.user.id}`, { data: { status: 'disabled' } })).status()).toBe(
      200,
    );
    expect((await page.request.get('/api/plans')).status()).toBe(401);
    // Prochain cycle de synchronisation : session refusée → espace verrouillé dans l'onglet.
    await page.getByTestId('sync-indicator').first().click();
    await page.getByTestId('sync-now').click();
    await expect(page.getByTestId('locked-screen')).toBeVisible({ timeout: 15_000 });
    await admin.patch(`/api/members/${me.user.id}`, { data: { status: 'active' } });
    await admin.dispose();
    await ctx.close();
  });
});
