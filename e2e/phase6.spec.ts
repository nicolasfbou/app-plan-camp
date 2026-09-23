import { readFileSync } from 'node:fs';
import { unzipSync } from 'fflate';
import { type Page, expect, test } from '@playwright/test';
// @ts-expect-error module JavaScript sans déclarations de types
import { inspectPdf } from '../bench/pdf-inspect.mjs';
import { asciiTempPath, clickOnCanvas, dragOnCanvas, openPlanWithPhoto, waitSaved } from './helpers.ts';

type Pt = { x: number; y: number };
type Obj = Record<string, unknown> & {
  id: string;
  type: string;
  name: string;
  geometry: Pt & Record<string, unknown>;
};
type Doc = {
  plan: Record<string, unknown> & {
    views: {
      id: string;
      name: string;
      print: { excludedObjectIds: string[]; style: Record<string, unknown> };
    }[];
    titleBlock: Record<string, unknown>;
    kind: string;
    variantOf: Record<string, unknown> | null;
    name: string;
  };
  objects: Record<string, Obj>;
  layers: { id: string; name: string }[];
  readabilityReviews: { key: string; status: string }[];
};

const storedDocs = async (page: Page) => {
  await waitSaved(page);
  return page.evaluate(
    () =>
      new Promise<Doc[]>((resolve) => {
        const open = indexedDB.open('campplanner');
        open.onsuccess = () => {
          const r = open.result.transaction('plans').objectStore('plans').getAll();
          r.onsuccess = () => {
            resolve((r.result as { document: Doc }[]).map((x) => x.document));
            open.result.close();
          };
        };
      }),
  );
};
const storedDocument = async (page: Page) => (await storedDocs(page))[0]!;

async function label(page: Page, at: [number, number], text: string) {
  await page.keyboard.press('g');
  await clickOnCanvas(page, at);
  await page.getByTestId('text-editor').fill(text);
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
}

async function flow(page: Page) {
  await page.getByRole('button', { name: 'Circulation véhicules', exact: true }).first().click();
  await page.locator('[data-flow-category="delivery"]').click();
  await clickOnCanvas(page, [100, 150]);
  await page.waitForTimeout(500); // deux clics rapprochés = double clic (fin du tracé)
  await clickOnCanvas(page, [650, 150]);
  await page.waitForTimeout(500);
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
}

async function openPrint(page: Page) {
  await page.getByTestId('open-print').click();
  await expect(page.getByTestId('print-dialog')).toBeVisible();
}

async function addView(page: Page, audience: string) {
  await page.getByTestId('view-add').click();
  await page.locator(`[data-audience="${audience}"]`).click();
}

async function download(page: Page, trigger: () => Promise<void>) {
  const [d] = await Promise.all([page.waitForEvent('download'), trigger()]);
  return { name: d.suggestedFilename(), path: (await d.path())!, bytes: readFileSync((await d.path())!) };
}

test.describe('Phase 6 — vues par public', () => {
  test('créer des vues, passer de l’une à l’autre sans modifier le plan, masquer un élément dans une vue', async ({
    page,
  }) => {
    await openPlanWithPhoto(page);
    // Zone de stationnement (masquée dans la vue Fournisseurs) et étiquette.
    await page.getByRole('button', { name: 'Rectangle', exact: true }).click();
    await page.locator('[data-preset="zone.parking"]').click();
    await dragOnCanvas(page, [150, 150], [350, 250]);
    await page.keyboard.press('Escape');
    await label(page, [300, 400], 'PORTAIL NORD');
    await openPrint(page);
    await addView(page, 'employees');
    await addView(page, 'suppliers');
    await page.getByRole('button', { name: 'Fermer' }).first().click();
    const before = await storedDocument(page);
    expect(before.plan.views.map((v) => v.name)).toEqual(['Employés', 'Fournisseurs']);

    // Changer de vue : état de l'éditeur seulement, le document enregistré ne change pas.
    const select = page.getByTestId('view-select');
    for (const name of ['Employés', 'Fournisseurs', 'Plan de base (tout)', 'Fournisseurs']) {
      await select.selectOption({ label: name });
      if (name !== 'Plan de base (tout)') await expect(page.getByTestId('view-banner')).toContainText(name);
    }
    const after = await storedDocument(page);
    expect(after).toEqual(before);

    // Vue Fournisseurs : le stationnement (calque exclu) n'est pas affiché.
    const zoneId = Object.values(before.objects).find((o) => o.type === 'zone')!.id;
    const shown = (id: string) =>
      page.evaluate(
        (id) =>
          (
            window as unknown as { Konva: { stages: { findOne(s: string): unknown }[] } }
          ).Konva.stages[0]!.findOne(`#${id}`) !== undefined,
        id,
      );
    await expect.poll(() => shown(zoneId)).toBe(false);

    // Masquer l'étiquette dans cette vue seulement.
    const labelId = Object.values(before.objects).find((o) => o.type === 'text')!.id;
    await page.getByRole('tab', { name: 'Calques' }).click();
    await page.getByTestId('layers-panel').getByRole('button', { name: 'Étiquette', exact: true }).click();
    await page.getByRole('tab', { name: 'Propriétés' }).click();
    await page.getByTestId('hide-in-view').click();
    const hidden = await storedDocument(page);
    expect(hidden.plan.views[1]!.print.excludedObjectIds).toEqual([labelId]);
    expect(hidden.plan.views[0]!.print.excludedObjectIds).toEqual([]);
    expect(hidden.objects[labelId]).toEqual(before.objects[labelId]); // l'objet lui-même est intact
    await expect.poll(() => shown(labelId)).toBe(false);
    await select.selectOption({ label: 'Plan de base (tout)' });
    await expect.poll(() => shown(labelId)).toBe(true);
    await expect.poll(() => shown(zoneId)).toBe(true);
  });

  test('export par vue, préréglage noir et blanc, export groupé (.zip et PDF multi-pages)', async ({
    page,
    browser,
  }) => {
    await openPlanWithPhoto(page);
    await flow(page);
    await label(page, [300, 400], 'PORTAIL NORD');
    await openPrint(page);
    await addView(page, 'suppliers');
    const settings = page.getByTestId('print-settings');
    await settings
      .getByRole('textbox', { name: 'Titre imprimé (vide = titre du plan)', exact: true })
      .fill('Accès fournisseurs');
    // PDF de la vue Fournisseurs : son titre et la mention du public.
    const pdf = await download(page, () => page.getByTestId('print-export').click());
    expect(pdf.name).toContain('Fournisseurs');
    const info = (await inspectPdf(browser, pdf.bytes)) as { text: string; pages: number };
    expect(info.text).toContain('Accès fournisseurs');
    expect(info.text).toContain('Destiné aux fournisseurs');

    // Préréglage Noir et blanc : l'image produite est en niveaux de gris (photo et annotations).
    await settings.getByRole('combobox', { name: 'Préréglage', exact: true }).selectOption('bw');
    await page.getByRole('radio', { name: 'PNG' }).click();
    const png = await download(page, () => page.getByTestId('print-export').click());
    const colorful = await page.evaluate(
      async (data) => {
        const bitmap = await createImageBitmap(new Blob([new Uint8Array(data)], { type: 'image/png' }));
        const c = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d')!;
        c.drawImage(bitmap, 0, 0);
        const d = c.getImageData(0, 0, bitmap.width, bitmap.height).data;
        let n = 0;
        for (let i = 0; i < d.length; i += 4 * 53)
          if (Math.abs(d[i]! - d[i + 1]!) > 3 || Math.abs(d[i + 1]! - d[i + 2]!) > 3) n++;
        return n;
      },
      [...png.bytes],
    );
    expect(colorful).toBe(0);
    await page.getByRole('radio', { name: 'PDF' }).click();

    // Deuxième vue, puis export groupé.
    await addView(page, 'management');
    await page.getByTestId('open-batch').click();
    const batch = page.getByTestId('batch-dialog');
    const zip = await download(page, () => page.getByTestId('batch-export').click());
    const files = Object.keys(unzipSync(new Uint8Array(zip.bytes)));
    expect(files).toHaveLength(2);
    expect(files.some((f) => f.includes('Fournisseurs'))).toBe(true);
    expect(files.some((f) => f.includes('Direction'))).toBe(true);
    await batch.getByLabel('Un seul PDF, une page par vue').check();
    const combined = await download(page, () => page.getByTestId('batch-export').click());
    const multi = (await inspectPdf(browser, combined.bytes)) as { pages: number };
    expect(multi.pages).toBe(2);
  });
});

test.describe('Phase 6 — lisibilité', () => {
  test('chevauchement détecté ; proposition refusée puis acceptée ; vérifié / ignoré', async ({ page }) => {
    await openPlanWithPhoto(page);
    await label(page, [330, 300], 'DORTOIR A — ACCÈS');
    await label(page, [345, 305], 'CUISINE — LIVRAISON');
    await page.getByRole('tab', { name: 'Analyse' }).click();
    const count = page.getByTestId('readability-count');
    await expect(count).toContainText('problème');
    const overlap = page.locator('[data-issue-kind="text-text"]');
    await expect(overlap).toHaveCount(1);

    // Proposer puis refuser : rien ne change.
    const before = await storedDocument(page);
    await overlap.getByTestId('propose').click();
    await expect(page.getByTestId('label-proposal')).toBeVisible();
    await page.getByTestId('proposal-refuse').click();
    await expect(page.getByTestId('label-proposal')).toBeHidden();
    expect(await storedDocument(page)).toEqual(before);

    // Proposer puis accepter : l'étiquette est déplacée, le chevauchement disparaît.
    await overlap.getByTestId('propose').click();
    await page.getByTestId('proposal-accept').click();
    const after = await storedDocument(page);
    const moved = Object.values(after.objects).filter(
      (o) => JSON.stringify(o.geometry) !== JSON.stringify(before.objects[o.id]!.geometry),
    );
    expect(moved).toHaveLength(1);
    await expect(page.locator('[data-issue-kind="text-text"]')).toHaveCount(0);
    // Annulable.
    await page.keyboard.press('Control+z');
    await expect(page.locator('[data-issue-kind="text-text"]')).toHaveCount(1);

    // Marquer vérifié : enregistré dans le plan, disparaît de la liste des problèmes ouverts.
    await page.locator('[data-issue-kind="text-text"]').getByTestId('mark-verified').click();
    await expect(page.locator('[data-issue-kind="text-text"]')).toHaveCount(0);
    const reviewed = await storedDocument(page);
    expect(reviewed.readabilityReviews).toEqual([expect.objectContaining({ status: 'verified' })]);
    await page.getByLabel('Afficher aussi les problèmes vérifiés ou ignorés').check();
    await expect(page.locator('[data-issue-status="verified"]')).toHaveCount(1);
  });
});

test.describe('Phase 6 — modèles et variantes', () => {
  test('enregistrer un modèle, l’exporter, le réimporter, créer un plan à partir du modèle', async ({
    page,
  }) => {
    await openPlanWithPhoto(page);
    await openPrint(page);
    await addView(page, 'employees');
    await page
      .getByTestId('print-settings')
      .getByRole('textbox', { name: 'Entreprise', exact: true })
      .fill('PAMM');
    await page.getByRole('button', { name: 'Fermer' }).first().click();
    await waitSaved(page);
    await page.getByRole('button', { name: 'Modèles', exact: true }).click();
    const dialog = page.getByTestId('templates-dialog');
    await dialog.getByLabel('Enregistrer ce plan comme modèle (nom)').fill('Modèle PAMM — employés');
    await dialog.getByTestId('template-save').click();
    await expect(dialog.locator('[data-template="Modèle PAMM — employés"]')).toBeVisible();
    const file = await download(page, () =>
      dialog.getByRole('button', { name: 'Exporter le modèle « Modèle PAMM — employés »' }).click(),
    );
    expect(file.name).toBe('Modele PAMM - employes.campmodele');
    const entries = Object.keys(unzipSync(new Uint8Array(file.bytes)));
    expect(entries.sort()).toEqual(['manifest.json', 'modele.json']);

    // Supprimé puis réimporté (comme sur un autre ordinateur).
    await dialog.getByRole('button', { name: 'Supprimer le modèle « Modèle PAMM — employés »' }).click();
    await page
      .getByRole('dialog', { name: 'Supprimer le modèle' })
      .getByRole('button', { name: 'Supprimer' })
      .click();
    await expect(dialog.getByText('Aucun modèle')).toBeVisible();
    const copy = asciiTempPath('pamm.campmodele');
    (await import('node:fs')).writeFileSync(copy, file.bytes);
    await dialog.getByTestId('template-input').setInputFiles(copy);
    await expect(dialog.locator('[data-template="Modèle PAMM — employés"]')).toBeVisible();
    await page.keyboard.press('Escape');

    // Nouveau plan à partir du modèle.
    await page.getByRole('link', { name: 'Camp test' }).click();
    await page.getByRole('button', { name: 'Nouveau plan' }).click();
    await page.getByLabel('Nom du plan').fill('Plan employés');
    await page.getByTestId('plan-template').selectOption({ label: 'Modèle PAMM — employés' });
    await page.getByRole('button', { name: 'Créer' }).click();
    await expect(page.getByTestId('plan-title')).toHaveText('Plan employés');
    const docs = await storedDocs(page);
    const created = docs.find((d) => d.plan.name === 'Plan employés')!;
    expect(created.plan.titleBlock.company).toBe('PAMM');
    expect(created.plan.views.map((v) => v.name)).toEqual(['Employés']);
    expect(Object.keys(created.objects)).toHaveLength(0);
  });

  test('variante été → hiver : tout est copié, puis les plans sont indépendants', async ({ page }) => {
    await openPlanWithPhoto(page);
    await flow(page);
    await page.getByRole('button', { name: 'Variante de ce plan (été / hiver…)' }).click();
    const dialog = page.getByTestId('variant-dialog');
    await dialog.getByLabel('Nom de la variante').fill('Circulation hiver');
    await dialog.getByTestId('variant-kind').selectOption('winter-circulation');
    await page.getByTestId('variant-create').click();
    await expect(page.getByTestId('plan-title')).toHaveText('Circulation hiver');
    await expect(page.getByTestId('navigation-controls')).toBeVisible();
    const docs = await storedDocs(page);
    const original = docs.find((d) => d.plan.name === 'Plan')!;
    const winter = docs.find((d) => d.plan.name === 'Circulation hiver')!;
    expect(winter.plan.kind).toBe('winter-circulation');
    expect(winter.plan.variantOf).toMatchObject({ planName: 'Plan' });
    expect(Object.keys(winter.objects)).toEqual(Object.keys(original.objects));
    // Modifier la variante ne touche pas l'original.
    await dragOnCanvas(page, [100, 150], [100, 150]); // clic (sélection) : aucune modification
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Delete');
    const after = await storedDocs(page);
    expect(Object.keys(after.find((d) => d.plan.name === 'Circulation hiver')!.objects)).toHaveLength(0);
    expect(Object.keys(after.find((d) => d.plan.name === 'Plan')!.objects)).toHaveLength(1);
  });
});
