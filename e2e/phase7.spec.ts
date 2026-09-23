import { readFileSync, writeFileSync } from 'node:fs';
import { strFromU8, unzipSync } from 'fflate';
import { type Page, expect, test } from '@playwright/test';
// @ts-expect-error module JavaScript sans déclarations de types
import { inspectPdf } from '../bench/pdf-inspect.mjs';
import {
  asciiTempPath,
  clickOnCanvas,
  dragOnCanvas,
  fixture,
  openPlanWithPhoto,
  sha256OfBuffer,
  sha256OfFile,
  waitForBackground,
  waitSaved,
} from './helpers.ts';

type Meta = { label: string; status: string; approval: { by: string } | null; snapshot: { sha256: string } };

async function download(page: Page, trigger: () => Promise<void>) {
  const [d] = await Promise.all([page.waitForEvent('download'), trigger()]);
  return { name: d.suggestedFilename(), bytes: readFileSync((await d.path())!) };
}

/** Révisions et instantanés tels qu'enregistrés dans IndexedDB. */
const storedRevisions = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<{ meta: Meta; json: string }[]>((resolve) => {
        const open = indexedDB.open('campplanner');
        open.onsuccess = () => {
          const tx = open.result.transaction(['revisions', 'revisionSnapshots']);
          const metas = tx.objectStore('revisions').getAll();
          const snaps = tx.objectStore('revisionSnapshots').getAll();
          tx.oncomplete = () => {
            const json = new Map((snaps.result as { id: string; json: string }[]).map((s) => [s.id, s.json]));
            resolve(
              (metas.result as { id: string; createdAt: string; meta: Meta }[])
                .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
                .map((r) => ({ meta: r.meta, json: json.get(r.id)! })),
            );
            open.result.close();
          };
        };
      }),
  );

async function openRevisions(page: Page) {
  await page.getByRole('tab', { name: 'Révisions' }).click();
  await expect(page.getByTestId('revisions-panel')).toBeVisible();
}

async function createRevision(page: Page, description: string) {
  await page.getByTestId('create-revision').click();
  const dialog = page.getByTestId('create-revision-dialog');
  await dialog.getByLabel('Description').fill(description);
  await dialog.getByLabel('Auteur').fill('N. Tremblay');
  await page.getByTestId('confirm-create-revision').click();
  await expect(dialog).toBeHidden();
  await waitSaved(page);
}

const card = (page: Page, label: string) =>
  page.locator(`[data-testid="revision-card"][data-label="${label}"]`);

async function label(page: Page, at: [number, number], text: string) {
  await page.keyboard.press('g');
  await clickOnCanvas(page, at);
  await page.getByTestId('text-editor').fill(text);
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
}

test.describe('Phase 7 — révisions', () => {
  test('A → brouillon modifié → comparaison → B → comparaison A ↔ B → export → rechargement : révisions intactes', async ({
    page,
    browser,
  }) => {
    test.setTimeout(120_000);
    await openPlanWithPhoto(page);
    await page.getByRole('button', { name: 'Rectangle', exact: true }).click();
    await page.locator('[data-preset="zone.delivery"]').click();
    await dragOnCanvas(page, [150, 150], [350, 250]);
    await page.keyboard.press('Escape');
    await label(page, [500, 400], 'PORTAIL NORD');
    await waitSaved(page);

    // 1. Révision A.
    await openRevisions(page);
    await expect(page.getByText('Aucune révision.')).toBeVisible();
    await createRevision(page, 'Émission initiale');
    await expect(card(page, 'A')).toContainText('Révision A');
    await expect(card(page, 'A')).toContainText('En révision');
    await expect(card(page, 'A')).toContainText('première révision');
    await expect(page.getByTestId('draft-changes')).toHaveText('0 changement(s) depuis la révision A.');
    const [revA] = await storedRevisions(page);

    // 2. Le brouillon change : zone déplacée (flèches), nouvelle étiquette.
    await page.keyboard.press('v');
    await clickOnCanvas(page, [250, 200]);
    for (let i = 0; i < 3; i++) await page.keyboard.press('Shift+ArrowRight');
    await page.keyboard.press('Escape');
    await label(page, [600, 250], 'PORTE EST');
    await waitSaved(page);
    await openRevisions(page);
    await expect(page.getByTestId('draft-changes')).toHaveText('2 changement(s) depuis la révision A.');

    // 3. Comparer A ↔ brouillon (superposition, puis avant / après).
    await page.getByTestId('compare-draft').click();
    const compare = page.getByTestId('compare-dialog');
    await expect(compare.getByTestId('compare-summary')).toContainText('Étiquette « PORTE EST » ajoutée');
    await expect(compare.getByTestId('compare-summary')).toContainText('déplacée');
    await expect(compare.getByTestId('compare-count')).toContainText('Révision A → Brouillon actuel : 2');
    await expect(compare.getByText('Rendu en cours…')).toBeHidden({ timeout: 20_000 });
    // Superposition : repères dessinés (vert « ajouté » autour de la nouvelle étiquette).
    const markerPixels = await compare
      .getByTestId('compare-overlay')
      .evaluate((canvas: HTMLCanvasElement) => {
        const data = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
        let n = 0;
        for (let i = 0; i < data.length; i += 4)
          if (Math.hypot(data[i]! - 22, data[i + 1]! - 163, data[i + 2]! - 74) < 40) n++;
        return n;
      });
    expect(markerPixels).toBeGreaterThan(30);
    await compare.getByRole('radio', { name: 'Avant / Après' }).click();
    await compare.getByTestId('show-before').click();
    await expect(compare.getByTestId('compare-slider')).toHaveValue('100');
    await compare.getByTestId('show-after').click();
    await expect(compare.getByTestId('compare-slider')).toHaveValue('0');
    await compare.locator('[data-kind="moved"]').click();
    await expect(compare.getByTestId('compare-focus')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(compare).toBeHidden();
    // La comparaison n'a rien modifié : la révision A est identique à l'octet.
    expect((await storedRevisions(page))[0]).toEqual(revA);

    // 4. Révision B.
    await createRevision(page, 'Modification de la circulation des fournisseurs');
    await expect(card(page, 'B')).toContainText('2 depuis A');
    await expect(page.getByTestId('draft-status')).toContainText('Issu de la révision B.');

    // 5. Comparer A ↔ B ; rapport de changements.
    await card(page, 'A').getByRole('checkbox').check();
    await card(page, 'B').getByRole('checkbox').check();
    await page.getByTestId('compare-selected').click();
    await expect(compare.getByTestId('compare-count')).toContainText('Révision A → Révision B : 2');
    await expect(compare.getByText('Rendu en cours…')).toBeHidden({ timeout: 20_000 });
    const report = await download(page, () => compare.getByTestId('report-pdf').click());
    expect(report.name).toBe('rapport-changements-A-B.pdf');
    const reportInfo = (await inspectPdf(browser, report.bytes)) as { allText: string; pages: number };
    expect(reportInfo.pages).toBe(2);
    expect(reportInfo.allText).toContain('Rapport de changements');
    expect(reportInfo.allText).toContain('PORTE EST');
    expect(reportInfo.allText).toContain('Changements automatiques');
    await page.keyboard.press('Escape');

    // 6. Approbation explicite de A : plus modifiable, plus supprimable.
    await card(page, 'A').getByRole('button', { name: 'Statut…' }).click();
    const status = page.getByTestId('status-dialog');
    await status.getByLabel('Nouveau statut').selectOption({ label: 'Approuvé' });
    await status.getByLabel('Approbateur (nom)').fill('M. Gagnon');
    await expect(page.getByTestId('confirm-status')).toBeDisabled(); // confirmation requise
    await status.getByLabel('Je confirme être autorisé(e) à approuver cette révision.').check();
    await page.getByTestId('confirm-status').click();
    await expect(card(page, 'A').getByTestId('revision-approval')).toContainText('M. Gagnon');
    await expect(card(page, 'A').getByRole('button', { name: 'Supprimer la révision A' })).toHaveCount(0);
    await expect(card(page, 'B').getByRole('button', { name: 'Supprimer la révision B' })).toHaveCount(1);

    // 7. PDF de la révision B (cartouche : révision, date, auteur, statut ; tableau des révisions).
    await card(page, 'B').getByRole('button', { name: 'Consulter' }).click();
    const viewer = page.getByTestId('revision-viewer');
    await expect(viewer.getByText('Rendu en cours…')).toBeHidden({ timeout: 20_000 });
    await expect(viewer.getByTestId('revision-integrity')).toContainText('Intégrité vérifiée');
    const pdf = await download(page, () => viewer.getByTestId('revision-export-pdf').click());
    expect(pdf.name).toMatch(/-revB\.pdf$/);
    const pdfInfo = (await inspectPdf(browser, pdf.bytes)) as { text: string };
    for (const text of ['RÉVISION B', 'N. Tremblay', 'En révision', 'Rév.', 'Émission initiale'])
      expect(pdfInfo.text).toContain(text);
    await page.keyboard.press('Escape');

    // 8. Export .campplan : deux révisions, photo une seule fois, SHA-256 identique.
    await waitSaved(page);
    const project = await download(page, () =>
      page.getByRole('button', { name: 'Exporter (.campplan)' }).click(),
    );
    const zip = unzipSync(new Uint8Array(project.bytes));
    const manifest = JSON.parse(strFromU8(zip['manifest.json']!)) as {
      formatVersion: number;
      revisions: { meta: Meta }[];
      files: { sha256: string }[];
    };
    expect(manifest.formatVersion).toBe(3);
    expect(manifest.revisions.map((r) => [r.meta.label, r.meta.status])).toEqual([
      ['A', 'approved'],
      ['B', 'review'],
    ]);
    expect(manifest.files.map((f) => f.sha256)).toEqual([sha256OfFile(fixture('quadrants.png'))]);
    expect(Object.keys(zip).filter((p) => p.startsWith('revisions/'))).toHaveLength(2);

    // 9. Rechargement : révisions intactes.
    const beforeReload = await storedRevisions(page);
    await page.reload();
    await waitForBackground(page);
    await openRevisions(page);
    await expect(card(page, 'A')).toContainText('Approuvé');
    await expect(card(page, 'B')).toContainText('En révision');
    expect(await storedRevisions(page)).toEqual(beforeReload);

    // 10. Import dans un navigateur vide : révisions intactes, comparaison fonctionnelle.
    const file = asciiTempPath('plan.campplan');
    writeFileSync(file, project.bytes);
    const context = await browser.newContext();
    const fresh = await context.newPage();
    await fresh.goto('/');
    await fresh.getByTestId('campplan-input').setInputFiles(file);
    await expect(fresh.getByTestId('import-revisions')).toHaveText('A, B');
    await fresh.getByRole('button', { name: 'Importer', exact: true }).click();
    await waitForBackground(fresh);
    await openRevisions(fresh);
    await expect(card(fresh, 'A')).toContainText('M. Gagnon');
    const imported = await storedRevisions(fresh);
    expect(imported.map((r) => r.json)).toEqual(beforeReload.map((r) => r.json));
    expect(imported.map((r) => r.meta.snapshot.sha256)).toEqual(
      beforeReload.map((r) => r.meta.snapshot.sha256),
    );
    await card(fresh, 'A').getByRole('checkbox').check();
    await card(fresh, 'B').getByRole('checkbox').check();
    await fresh.getByTestId('compare-selected').click();
    await expect(fresh.getByTestId('compare-count')).toContainText('Révision A → Révision B : 2');
    await fresh.keyboard.press('Escape');
    await fresh.getByRole('tab', { name: 'Fond' }).click();
    await expect(fresh.getByTestId('bg-sha256')).toHaveText(
      sha256OfBuffer(readFileSync(fixture('quadrants.png'))),
    );
    await context.close();
  });

  test('suppression protégée ; brouillon à partir d’une révision ; statut « Approuvé » jamais automatique', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await openPlanWithPhoto(page);
    await label(page, [300, 300], 'ACCUEIL');
    await waitSaved(page);
    await openRevisions(page);
    await createRevision(page, 'Première émission');
    // Création : seuls Brouillon, En révision, À valider sur le terrain sont proposés.
    await page.getByTestId('create-revision').click();
    const options = await page
      .getByTestId('create-revision-dialog')
      .getByLabel('Statut')
      .locator('option')
      .allTextContents();
    expect(options).toEqual(['Brouillon', 'En révision', 'À valider sur le terrain']);
    await page.keyboard.press('Escape');

    // Le brouillon change, révision B, puis suppression de B (saisie du numéro exigée).
    await label(page, [500, 200], 'ENTREPÔT');
    await waitSaved(page);
    await openRevisions(page);
    await createRevision(page, 'Ajout entrepôt');
    await card(page, 'B').getByRole('button', { name: 'Supprimer la révision B' }).click();
    const del = page.getByTestId('delete-revision-dialog');
    await expect(del).toContainText('Révision B');
    await expect(del).toContainText('En révision');
    await expect(page.getByTestId('confirm-delete-revision')).toBeDisabled();
    await del.getByRole('textbox').fill('B');
    await page.getByTestId('confirm-delete-revision').click();
    await expect(card(page, 'B')).toHaveCount(0);

    // Brouillon à partir de A : le contenu de A revient (annulable), A reste intacte.
    const [revA] = await storedRevisions(page);
    await card(page, 'A').getByRole('button', { name: 'Brouillon…' }).click();
    await expect(page.getByTestId('restore-dialog')).toContainText('1 changement(s)');
    await page.getByTestId('confirm-restore').click();
    await expect(page.getByTestId('draft-changes')).toHaveText('0 changement(s) depuis la révision A.');
    expect((await storedRevisions(page))[0]).toEqual(revA);
    await page.keyboard.press('Control+z');
    await expect(page.getByTestId('draft-changes')).toHaveText('1 changement(s) depuis la révision A.');

    // Approuver A, puis supprimer le plan : deuxième confirmation (nom du plan) exigée.
    await card(page, 'A').getByRole('button', { name: 'Statut…' }).click();
    const status = page.getByTestId('status-dialog');
    await status.getByLabel('Nouveau statut').selectOption({ label: 'Approuvé' });
    await status.getByLabel('Approbateur (nom)').fill('M. Gagnon');
    await status.getByLabel('Je confirme être autorisé(e) à approuver cette révision.').check();
    await page.getByTestId('confirm-status').click();
    await expect(card(page, 'A').getByRole('button', { name: 'Statut…' })).toBeVisible(); // archivage seulement
    await waitSaved(page);
    await page.getByRole('link', { name: 'Camp test' }).click();
    await page.getByRole('button', { name: 'Supprimer Plan' }).click();
    const protectedDelete = page.getByTestId('protected-delete');
    await expect(page.getByTestId('delete-revision-count')).toHaveText(
      'Ce plan et ses 1 révision(s) figée(s) seront supprimés.',
    );
    await page.getByTestId('confirm-protected-delete').click();
    await expect(protectedDelete).toContainText('révision(s) approuvée(s) : A (Approuvé)');
    await expect(page.getByTestId('confirm-protected-delete')).toBeDisabled();
    await page.getByTestId('protected-delete-name').fill('Plan');
    await page.getByTestId('confirm-protected-delete').click();
    await expect(page.getByTestId('plan-row')).toHaveCount(0);
    expect(await storedRevisions(page)).toEqual([]);
  });
});
