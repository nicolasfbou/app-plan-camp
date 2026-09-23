import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type BrowserContext, type Page, chromium, expect, test } from '@playwright/test';
import {
  asciiTempPath,
  clickOnCanvas,
  dragOnCanvas,
  fixture,
  openPlanWithPhoto,
  sha256OfFile,
  sha256OfBuffer,
  waitForBackground,
  waitSaved,
} from './helpers.ts';

type Doc = {
  plan: { id: string; name: string; metadata: Record<string, unknown> };
  objects: Record<string, { id: string; type: string; geometry: { x?: number } }>;
};

async function download(page: Page, trigger: () => Promise<void>) {
  const [d] = await Promise.all([page.waitForEvent('download'), trigger()]);
  return { name: d.suggestedFilename(), bytes: readFileSync((await d.path())!) };
}

const idb = <T>(page: Page, store: string) =>
  page.evaluate(
    (store) =>
      new Promise<T[]>((resolve) => {
        const open = indexedDB.open('campplanner');
        open.onsuccess = () => {
          const r = open.result.transaction(store).objectStore(store).getAll();
          r.onsuccess = () => {
            resolve(r.result as T[]);
            open.result.close();
          };
        };
      }),
    store,
  );
const storedDocs = async (page: Page) => (await idb<{ document: Doc }>(page, 'plans')).map((r) => r.document);

async function label(page: Page, at: [number, number], text: string) {
  await page.keyboard.press('g');
  await clickOnCanvas(page, at);
  await page.getByTestId('text-editor').fill(text);
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
}

const konvaObjects = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as { Konva: { stages: { find(s: string): unknown[] }[] } }).Konva.stages[0]!.find(
        '.plan-object',
      ).length,
  );

/**
 * « Plantage » réel : le processus Chromium est tué (SIGKILL) — aucun `pagehide`, aucun
 * `beforeunload`, aucune écriture de dernière minute — puis relancé sur le MÊME profil (le
 * stockage IndexedDB sur disque est relu comme après une panne).
 */
class CrashableBrowser {
  readonly dir = mkdtempSync(join(tmpdir(), 'campplanner-crash-'));
  context!: BrowserContext;
  errors: string[] = [];
  async launch() {
    this.context = await chromium.launchPersistentContext(this.dir, {
      executablePath: process.env.PW_CHROMIUM_PATH,
      baseURL: 'http://localhost:4173',
      viewport: { width: 1280, height: 720 },
      acceptDownloads: true,
    });
    const page = this.context.pages()[0] ?? (await this.context.newPage());
    this.errors = [];
    page.on('pageerror', (e) => this.errors.push(e.message));
    return page;
  }
  /** SIGKILL de tous les processus Chromium dont la ligne de commande cite ce profil. */
  kill() {
    for (const pid of readdirSync('/proc').filter((d) => /^\d+$/.test(d))) {
      if (Number(pid) === process.pid) continue;
      try {
        const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
        if (cmd.includes(this.dir)) process.kill(Number(pid), 'SIGKILL');
      } catch {
        // processus déjà terminé
      }
    }
  }
  async crashAndRelaunch(url: string) {
    this.kill();
    await this.context.close().catch(() => undefined);
    const page = await this.launch();
    await page.goto(url);
    return page;
  }
}

test.describe('Phase 8 — verrou multi-onglet et conflits', () => {
  test('deuxième onglet en lecture seule, suit les enregistrements, reprend la main ; fermeture → relais', async ({
    page,
    context,
  }) => {
    test.setTimeout(90_000);
    await openPlanWithPhoto(page);
    await label(page, [300, 300], 'ACCUEIL');
    await waitSaved(page);
    const url = page.url();

    const b = await context.newPage();
    await b.goto(url);
    await waitForBackground(b);
    await expect(b.getByTestId('lock-banner')).toContainText('déjà ouvert ailleurs');
    await expect(page.getByTestId('lock-banner')).toHaveCount(0);
    // Lecture seule : dessiner ne crée rien.
    await b.getByRole('button', { name: 'Rectangle', exact: true }).click();
    await dragOnCanvas(b, [100, 100], [200, 200]);
    await expect.poll(() => konvaObjects(b)).toBe(1);
    // L'onglet éditeur enregistre : le lecteur se met à jour.
    await label(page, [500, 300], 'SORTIE');
    await waitSaved(page);
    await expect.poll(() => konvaObjects(b)).toBe(2);

    // Reprendre la main : A écrit, cède, passe en lecture seule.
    await label(page, [400, 450], 'ATELIER');
    await b.getByTestId('lock-takeover').click();
    await expect(b.getByTestId('lock-banner')).toHaveCount(0);
    await expect(page.getByTestId('lock-banner')).toBeVisible();
    await expect.poll(() => konvaObjects(b)).toBe(3); // modification de A écrite avant de céder
    await label(b, [600, 450], 'QUAI');
    await waitSaved(b);
    await expect.poll(() => konvaObjects(page)).toBe(4);
    // B se ferme : A reprend la main tout seul (après relecture).
    await b.close();
    await expect(page.getByTestId('lock-banner')).toHaveCount(0, { timeout: 10_000 });
    await label(page, [250, 500], 'PARC');
    await waitSaved(page);
    expect(Object.keys((await storedDocs(page))[0]!.objects)).toHaveLength(5);
  });

  test('plan modifié ailleurs pendant l’édition : conflit affiché, copie sans perte', async ({
    page,
    context,
  }) => {
    await openPlanWithPhoto(page);
    await label(page, [300, 300], 'A1');
    await waitSaved(page);
    // Autre fenêtre : renommage depuis la liste des plans (version enregistrée +1).
    const other = await context.newPage();
    await other.goto(page.url().replace(/\/plan\/.*$/, ''));
    await other.getByRole('button', { name: 'Renommer Plan' }).click();
    await other.getByLabel('Nom du plan').fill('Plan renommé ailleurs');
    await other.getByRole('button', { name: 'Enregistrer' }).click();
    await expect(other.getByTestId('plan-row')).toContainText('Plan renommé ailleurs');
    await other.close();
    // L'éditeur modifie : l'enregistrement est refusé, conflit affiché (rien d'écrasé).
    await label(page, [500, 300], 'A2');
    const dialog = page.getByTestId('conflict-dialog');
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    expect((await storedDocs(page))[0]!.plan.name).toBe('Plan renommé ailleurs');
    await expect(page.getByTestId('conflict-overwrite')).toBeDisabled();
    await page.getByTestId('conflict-copy').click();
    await expect(dialog).toBeHidden();
    const docs = await storedDocs(page);
    expect(docs.map((d) => d.plan.name).sort()).toEqual(
      [
        'Plan (conflit ' + docs.find((d) => d.plan.name.startsWith('Plan (conflit'))!.plan.name.slice(14),
        'Plan renommé ailleurs',
      ].sort(),
    );
    const copy = docs.find((d) => d.plan.name.startsWith('Plan (conflit'))!;
    expect(Object.keys(copy.objects)).toHaveLength(2); // A1 + A2 : rien de perdu
    await expect(page.getByTestId('plan-title')).toHaveText('Plan renommé ailleurs');
  });
});

test.describe('Phase 8 — récupération après plantage', () => {
  test('processus tué pendant un glisser, après une modification, pendant une révision, pendant un export : état cohérent', async () => {
    test.setTimeout(180_000);
    const browser = new CrashableBrowser();
    let page = await browser.launch();
    await openPlanWithPhoto(page);
    await label(page, [300, 300], 'AVANT');
    await waitSaved(page);
    const url = page.url();
    const before = (await storedDocs(page))[0]!;

    // 1. Tué en plein glisser (bouton enfoncé, geste non validé).
    await page.keyboard.press('v');
    const box = (await page.getByTestId('canvas-container').boundingBox())!;
    await page.mouse.move(box.x + 300, box.y + 300);
    await page.mouse.down();
    await page.mouse.move(box.x + 450, box.y + 380, { steps: 5 });
    page = await browser.crashAndRelaunch(url);
    await waitForBackground(page);
    expect(browser.errors).toEqual([]);
    expect((await storedDocs(page))[0]).toEqual(before); // rien d'écrit à moitié

    // 2. Tué juste après une modification (enregistrement automatique en cours ou pas encore fait).
    await label(page, [500, 300], 'PENDANT');
    page = await browser.crashAndRelaunch(url);
    await waitForBackground(page);
    const afterSave = (await storedDocs(page))[0]!;
    // Soit avant, soit après la modification — jamais un document partiel ou illisible.
    expect([1, 2]).toContain(Object.keys(afterSave.objects).length);
    await expect(page.getByTestId('plan-title')).toHaveText('Plan');

    // 3. Tué pendant la création d'une révision : tout ou rien (métadonnées ET instantané).
    await page.getByRole('tab', { name: 'Révisions' }).click();
    await page.getByTestId('create-revision').click();
    await page.getByTestId('create-revision-dialog').getByLabel('Auteur').fill('N. Tremblay');
    await page.getByTestId('confirm-create-revision').click();
    page = await browser.crashAndRelaunch(url);
    await waitForBackground(page);
    const metas = await idb<{ id: string }>(page, 'revisions');
    const snaps = await idb<{ id: string }>(page, 'revisionSnapshots');
    expect(metas.map((m) => m.id).sort()).toEqual(snaps.map((x) => x.id).sort());
    await page.getByRole('tab', { name: 'Révisions' }).click();
    await expect(page.getByTestId('revision-card')).toHaveCount(metas.length);
    for (const card of await page.getByTestId('revision-card').all())
      await expect(card).not.toContainText('altérée');

    // 4. Tué pendant un export .campplan : aucune donnée touchée.
    const stored = await storedDocs(page);
    await page.getByRole('button', { name: 'Exporter (.campplan)' }).click();
    page = await browser.crashAndRelaunch(url); // l'export est encore en cours
    await waitForBackground(page);
    expect(await storedDocs(page)).toEqual(stored);
    expect(browser.errors).toEqual([]);
    await browser.context.close();
  });

  test('processus tué pendant un import : aucun plan partiel', async ({ page }) => {
    await openPlanWithPhoto(page);
    await waitSaved(page);
    const project = await download(page, () =>
      page.getByRole('button', { name: 'Exporter (.campplan)' }).click(),
    );
    const file = asciiTempPath('plan.campplan');
    writeFileSync(file, project.bytes);
    const browser = new CrashableBrowser();
    let fresh = await browser.launch();
    await fresh.goto('/');
    await fresh.getByTestId('campplan-input').setInputFiles(file);
    await fresh.getByRole('button', { name: 'Importer', exact: true }).click();
    fresh = await browser.crashAndRelaunch('/');
    await expect(fresh.getByRole('heading', { name: 'Camps' }).first()).toBeVisible();
    const docs = await storedDocs(fresh);
    // Transaction unique : soit rien, soit le plan COMPLET.
    expect([0, 1]).toContain(docs.length);
    for (const d of docs) expect(d.plan.name).toBe('Plan');
    // Si le plan est là, sa photo l'est aussi, identique.
    if (docs.length) {
      await fresh.goto(
        `/#/camp/${(docs[0]!.plan as unknown as { siteId: string }).siteId}/plan/${docs[0]!.plan.id}`,
      );
      await waitForBackground(fresh);
    }
    expect(browser.errors).toEqual([]);
    await browser.context.close();
  });
});

test.describe('Phase 8 — sauvegardes, santé, nettoyage, diagnostic, secours', () => {
  // Dossier de sauvegarde : le sélecteur natif exige un clic humain ; il est remplacé ici par un
  // dossier du système de fichiers privé du navigateur (même API d'écriture).
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      (window as unknown as { showDirectoryPicker: unknown }).showDirectoryPicker = async () =>
        (await navigator.storage.getDirectory()).getDirectoryHandle('Sauvegardes CampPlanner', {
          create: true,
        });
    });
  });

  const backupFiles = (page: Page) =>
    page.evaluate(async () => {
      const out: string[] = [];
      const walk = async (dir: FileSystemDirectoryHandle, path: string) => {
        for await (const entry of (dir as unknown as { values(): AsyncIterable<FileSystemHandle> }).values())
          if (entry.kind === 'directory')
            await walk(entry as FileSystemDirectoryHandle, `${path}${entry.name}/`);
          else out.push(`${path}${entry.name}`);
      };
      await walk(
        await (
          await navigator.storage.getDirectory()
        ).getDirectoryHandle('Sauvegardes CampPlanner', { create: true }),
        '',
      );
      return out.sort();
    });

  test('sauvegarde externe : dossier, horodatage, rotation, révision approuvée conservée, historique', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await openPlanWithPhoto(page);
    await label(page, [300, 300], 'S1');
    await waitSaved(page);
    await page.getByRole('button', { name: 'Santé et sauvegardes' }).click();
    const dialog = page.getByTestId('maintenance-dialog');
    await dialog.getByRole('tab', { name: 'Sauvegardes externes' }).click();
    await expect(dialog.getByTestId('backup-folder-state')).toContainText('Aucun dossier');
    await dialog.getByTestId('backup-choose-folder').click();
    await expect(dialog.getByTestId('backup-folder-state')).toContainText('Sauvegardes CampPlanner');
    await dialog.getByTestId('policy-quick').fill('2');
    await dialog.getByTestId('policy-daily').fill('0');
    await dialog.getByTestId('policy-weekly').fill('0');
    for (let i = 0; i < 4; i++) {
      await dialog.getByTestId('backup-this-plan').click();
      await expect(dialog.getByTestId('backup-message')).toContainText('Sauvegarde écrite');
      await page.waitForTimeout(1100); // horodatage à la seconde
    }
    let files = await backupFiles(page);
    expect(files).toHaveLength(2);
    expect(files[0]).toMatch(
      /^Camp test\/Plan \[.{8}\]\/Plan - \d{4}-\d{2}-\d{2} \d{2}h\d{2}m\d{2} - rapide\.campplan$/,
    );
    await expect(dialog.getByTestId('backup-history').locator('li')).toHaveCount(4);
    await page.keyboard.press('Escape');

    // Révision créée puis approuvée : sauvegardes « revision-A » puis « approuvee-A » (conservée).
    await page.getByRole('tab', { name: 'Révisions' }).click();
    await page.getByTestId('create-revision').click();
    await page.getByTestId('create-revision-dialog').getByLabel('Auteur').fill('N. Tremblay');
    await page.getByTestId('confirm-create-revision').click();
    await expect
      .poll(async () => (await backupFiles(page)).some((f) => f.endsWith('revision-A.campplan')))
      .toBe(true);
    await page.getByRole('button', { name: 'Statut…' }).click();
    await page.getByTestId('status-dialog').getByLabel('Nouveau statut').selectOption({ label: 'Approuvé' });
    await page.getByTestId('status-dialog').getByLabel('Approbateur (nom)').fill('M. Gagnon');
    await page
      .getByTestId('status-dialog')
      .getByLabel('Je confirme être autorisé(e) à approuver cette révision.')
      .check();
    await page.getByTestId('confirm-status').click();
    await expect
      .poll(async () => (await backupFiles(page)).some((f) => f.endsWith('approuvee-A.campplan')))
      .toBe(true);
    // D'autres sauvegardes rapides n'effacent jamais celle de l'approbation.
    await page.getByRole('button', { name: 'Santé et sauvegardes' }).click();
    await dialog.getByRole('tab', { name: 'Sauvegardes externes' }).click();
    for (let i = 0; i < 3; i++) {
      await page.waitForTimeout(1100);
      await dialog.getByTestId('backup-this-plan').click();
    }
    await expect
      .poll(async () => (await backupFiles(page)).filter((f) => f.endsWith('rapide.campplan')).length)
      .toBe(2);
    files = await backupFiles(page);
    expect(files.some((f) => f.endsWith('approuvee-A.campplan'))).toBe(true);
    // Le contenu écrit est un .campplan complet (photo identique).
    const bytes = await page.evaluate(
      async (name) => {
        let dir = await (
          await navigator.storage.getDirectory()
        ).getDirectoryHandle('Sauvegardes CampPlanner');
        const parts = name.split('/');
        for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p);
        const file = await (await dir.getFileHandle(parts.at(-1)!)).getFile();
        return Array.from(new Uint8Array(await file.arrayBuffer()));
      },
      files.find((f) => f.endsWith('approuvee-A.campplan'))!,
    );
    const zip = unzipSync(new Uint8Array(bytes));
    const manifest = JSON.parse(strFromU8(zip['manifest.json']!)) as {
      files: { sha256: string }[];
      revisions: { meta: { status: string } }[];
    };
    expect(manifest.files[0]!.sha256).toBe(sha256OfFile(fixture('quadrants.png')));
    expect(manifest.revisions[0]!.meta.status).toBe('approved');
  });

  test('santé du projet, réparation contrôlée, nettoyage, journal, diagnostic, copie de secours, récupération', async ({
    page,
    browser,
  }) => {
    test.setTimeout(120_000);
    await openPlanWithPhoto(page);
    await label(page, [300, 300], 'SANTÉ');
    await waitSaved(page);
    const planUrl = page.url();
    // Défauts simulés : fichier orphelin ancien, préférence de vue corrompue.
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          const open = indexedDB.open('campplanner');
          open.onsuccess = () => {
            const tx = open.result.transaction(['blobs', 'viewPrefs', 'plans'], 'readwrite');
            tx.objectStore('blobs').put({
              id: 'orphelin-ancien',
              bytes: new ArrayBuffer(512 * 1024),
              mimeType: 'image/png',
              byteLength: 512 * 1024,
              sha256: '0'.repeat(64),
              createdAt: '2020-01-01T00:00:00.000Z',
            });
            const plans = tx.objectStore('plans').getAll();
            plans.onsuccess = () =>
              tx.objectStore('viewPrefs').put({
                planId: (plans.result[0] as { id: string }).id,
                centerX: Number.NaN,
                centerY: 0,
                scale: 1,
              });
            tx.oncomplete = () => {
              open.result.close();
              resolve();
            };
          };
        }),
    );
    await page.getByRole('button', { name: 'Santé et sauvegardes' }).click();
    const dialog = page.getByTestId('maintenance-dialog');
    const check = (id: string) => dialog.locator(`[data-check="${id}"]`);
    await expect(check('photo-sha')).toHaveAttribute('data-status', 'ok', { timeout: 20_000 });
    await expect(check('photo-sha')).toContainText(sha256OfFile(fixture('quadrants.png')));
    await expect(check('backup')).toHaveAttribute('data-status', 'error'); // jamais sauvegardé à l'extérieur
    await expect(check('prefs')).toHaveAttribute('data-status', 'warn');
    await expect(check('orphans')).toHaveAttribute('data-status', 'ok'); // 0,5 Mo : sous le seuil d'alerte
    await expect(dialog.getByTestId('health-overall')).toHaveAttribute('data-status', 'error');
    // Réparation : confirmation, sauvegarde proposée.
    await dialog.getByTestId('repair-prefs').click();
    await page.getByTestId('repair-without-backup').click();
    await expect(dialog.getByTestId('repair-result')).toContainText('réinitialisée');
    await expect(check('prefs')).toHaveAttribute('data-status', 'ok');
    // Ignorer : toujours affiché, avec sa couleur.
    await check('backup').getByRole('button', { name: 'Ignorer' }).click();
    await expect(check('backup')).toContainText('ignoré');
    await expect(check('backup')).toHaveAttribute('data-status', 'error');

    // Nettoyage : espace annoncé avant suppression.
    await dialog.getByRole('tab', { name: 'Nettoyage' }).click();
    await dialog.getByTestId('cleanup-analyse').click();
    await expect(dialog.getByTestId('cleanup-total')).toContainText('0.50 Mo');
    await dialog.getByTestId('cleanup-apply').click();
    await page.getByTestId('cleanup-confirm').click();
    await expect(dialog.getByTestId('cleanup-empty')).toBeVisible();
    expect((await idb<{ id: string }>(page, 'blobs')).map((b) => b.id)).not.toContain('orphelin-ancien');
    expect(await idb(page, 'blobs')).toHaveLength(1); // la photo, jamais touchée

    // Journal : une erreur d'import y est consignée ; vidable.
    await page.keyboard.press('Escape');
    const bad = asciiTempPath('abime.campplan');
    writeFileSync(bad, 'pas une archive');
    const home = page.url().replace(/#.*$/, '');
    await page.goto(home);
    await page.getByTestId('campplan-input').setInputFiles(bad);
    await page
      .getByRole('dialog', { name: 'Import impossible' })
      .getByRole('button', { name: 'Fermer' })
      .click();
    await page.getByTestId('open-maintenance').click();
    await dialog.getByRole('tab', { name: 'Journal des erreurs' }).click();
    await expect(dialog.getByTestId('journal-list')).toContainText('Fichier illisible');

    // Diagnostic : ni photo ni noms par défaut.
    await dialog.getByRole('tab', { name: 'Diagnostic' }).click();
    const report = await download(page, () => dialog.getByTestId('diagnostic-export').click());
    const json = JSON.parse(report.bytes.toString('utf8')) as {
      plans: { objects: number; photo: { sha256: string } }[];
      errorLog: unknown[];
      application: { version: string };
    };
    expect(json.application.version).toBe('0.1.0');
    expect(json.plans[0]!.objects).toBe(1);
    expect(json.plans[0]!.photo.sha256).toBe(sha256OfFile(fixture('quadrants.png')));
    expect(report.bytes.toString('utf8')).not.toContain('SANTÉ');
    expect(report.bytes.toString('utf8')).not.toContain('Camp test');
    expect(report.bytes.length).toBeLessThan(200_000);
    await dialog.getByRole('tab', { name: 'Journal des erreurs' }).click();
    await dialog.getByTestId('journal-clear').click();
    await page.getByTestId('journal-clear-confirm').click();
    await expect(dialog.getByTestId('journal-list')).toContainText('Aucune erreur');
    await page.keyboard.press('Escape');

    // Copie de secours depuis l'éditeur, révision altérée : copie incomplète, dite ; récupération.
    await page.goto(planUrl);
    await waitForBackground(page);
    await page.getByRole('tab', { name: 'Révisions' }).click();
    for (const text of ['A', 'B']) {
      if (text === 'B') await label(page, [600, 200], 'AJOUT B');
      await waitSaved(page);
      await page.getByTestId('create-revision').click();
      await page.getByTestId('create-revision-dialog').getByLabel('Auteur').fill('N. Tremblay');
      await page.getByTestId('confirm-create-revision').click();
      await expect(page.locator(`[data-testid="revision-card"][data-label="${text}"]`)).toBeVisible();
      await page.getByRole('tab', { name: 'Révisions' }).click();
    }
    const revB = (await idb<{ id: string; meta: { label: string } }>(page, 'revisions')).find(
      (r) => r.meta.label === 'B',
    )!;
    await page.evaluate(
      (id) =>
        new Promise<void>((resolve) => {
          const open = indexedDB.open('campplanner');
          open.onsuccess = () => {
            const tx = open.result.transaction('revisionSnapshots', 'readwrite');
            tx.objectStore('revisionSnapshots').put({ id, json: '{"altéré":true}' });
            tx.oncomplete = () => {
              open.result.close();
              resolve();
            };
          };
        }),
      revB.id,
    );
    const emergency = await download(page, () =>
      page.getByRole('button', { name: 'Exporter une copie de secours maintenant' }).click(),
    );
    expect(emergency.name).toMatch(/SECOURS .*\.campplan$/);
    await expect(page.getByRole('status').filter({ hasText: 'INCOMPLÈTE' })).toBeVisible();
    const emergencyZip = unzipSync(new Uint8Array(emergency.bytes));
    expect(strFromU8(emergencyZip['LISEZ-MOI.txt']!)).toMatch(/Révision B non incluse/);

    // Import dans un navigateur vide : refus en lecture normale, récupération explicite.
    const file = asciiTempPath('secours.campplan');
    writeFileSync(file, emergency.bytes);
    const fresh = await (await browser.newContext()).newPage();
    await fresh.goto('/');
    await fresh.getByTestId('campplan-input').setInputFiles(file);
    await expect(fresh.getByRole('dialog', { name: 'Import impossible' })).toContainText('INCOMPLÈTE');
    await fresh.getByTestId('import-try-recovery').click();
    await expect(fresh.getByTestId('import-recovery')).toContainText('Révision B non incluse');
    await expect(fresh.getByLabel('Nom du plan')).toHaveValue('Plan (récupéré — incomplet)');
    await fresh.getByRole('button', { name: 'Importer', exact: true }).click();
    await waitForBackground(fresh);
    await expect(fresh.getByTestId('recovered-banner')).toContainText('RÉCUPÉRÉ PARTIELLEMENT');
    await fresh.getByRole('tab', { name: 'Révisions' }).click();
    await expect(fresh.getByTestId('revision-card')).toHaveCount(1);
    await fresh.getByRole('tab', { name: 'Fond' }).click();
    await expect(fresh.getByTestId('bg-sha256')).toHaveText(sha256OfFile(fixture('quadrants.png')));

    // Fichier .campplan dont le plan a été modifié à la main : récupération, problème listé.
    const zip = unzipSync(new Uint8Array(emergency.bytes));
    zip['plan.json'] = strToU8(strFromU8(zip['plan.json']!).replace('"SANTÉ"', '"SANTÉ modifié"'));
    const tampered = asciiTempPath('altere.campplan');
    writeFileSync(tampered, zipSync(zip));
    await fresh.goto('/');
    await fresh.getByTestId('campplan-input').setInputFiles(tampered);
    await fresh.getByTestId('import-try-recovery').click();
    await expect(fresh.getByTestId('import-recovery')).toContainText('empreinte SHA-256 différente');
  });
});

test.describe('Phase 8 — plan illisible', () => {
  test('le plan ne s’ouvre plus : copie de secours et santé restent accessibles depuis la page d’erreur', async ({
    page,
  }) => {
    await openPlanWithPhoto(page);
    await label(page, [300, 300], 'ACCUEIL');
    await waitSaved(page);
    const url = page.url();
    await page.goto('/#/');
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          const open = indexedDB.open('campplanner');
          open.onsuccess = () => {
            const tx = open.result.transaction('plans', 'readwrite');
            const all = tx.objectStore('plans').getAll();
            all.onsuccess = () => {
              for (const r of all.result as { document: Record<string, unknown> }[])
                tx.objectStore('plans').put({ ...r, document: { ...r.document, plan: 'cassé' } });
            };
            tx.oncomplete = () => {
              open.result.close();
              resolve();
            };
          };
        }),
    );
    await page.goto(url);
    const button = page.getByTestId('load-error-emergency');
    await expect(button).toBeVisible();
    const copy = await download(page, () => button.click());
    expect(copy.name).toMatch(/SECOURS/);
    const zip = unzipSync(new Uint8Array(copy.bytes));
    expect(Object.keys(zip)).toContain('plan-brut.json');
    // La photo originale est jointe, octet pour octet, même sans document lisible.
    const photoSha = sha256OfFile(fixture('quadrants.png'));
    expect(
      Object.entries(zip).some(
        ([k, v]) => k.startsWith('fichiers') && sha256OfBuffer(Buffer.from(v)) === photoSha,
      ),
    ).toBe(true);
    expect(strFromU8(zip['LISEZ-MOI.txt']!)).toMatch(/INCOMPLÈTE/);
    await page.getByRole('button', { name: 'Ouvrir « Santé et sauvegardes »' }).click();
    await expect(page.getByTestId('health-overall')).toHaveAttribute('data-status', 'error');
  });
});
