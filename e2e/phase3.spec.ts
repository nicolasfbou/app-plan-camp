import { readFileSync, writeFileSync } from 'node:fs';
import { type Page, expect, test } from '@playwright/test';
import {
  asciiTempPath,
  clickOnCanvas,
  createCamp,
  createPlan,
  dragOnCanvas,
  fixture,
  importBackground,
  openFreshApp,
  openPlanWithPhoto,
  planNodes,
  sha256OfBuffer,
  sha256OfFile,
  storedObjects,
  waitForBackground,
  waitSaved,
} from './helpers.ts';

type Geo = { kind: string; x?: number; points?: { x: number; y: number }[] };

/** Ordre des calques dans le rendu Konva (du dessous vers le dessus). */
const renderedLayerOrder = (page: Page) =>
  page.evaluate(() => {
    const K = (
      window as unknown as {
        Konva: { stages: { findOne(s: string): { getChildren(): { id(): string }[] } }[] };
      }
    ).Konva;
    return K.stages[0]!.findOne('.content')
      .getChildren()
      .map((g) => g.id());
  });

test.describe('.campplan', () => {
  test('exporter → importer dans un navigateur au stockage VIDE : plan et photo identiques', async ({
    page,
    browser,
  }) => {
    await openPlanWithPhoto(page, fixture('quadrants.jpg'));
    await page.keyboard.press('r');
    await dragOnCanvas(page, [300, 300], [450, 400]);
    await page.keyboard.press('g');
    await clickOnCanvas(page, [600, 300]);
    await page.getByTestId('text-editor').fill('DORTOIR 1');
    await page.keyboard.press('Enter');
    await waitSaved(page);
    const before = await storedObjects(page);

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Exporter (.campplan)' }).click(),
    ]);
    expect(download.suggestedFilename()).toBe('Camp test - Plan.campplan');
    const file = asciiTempPath('export.campplan');
    await download.saveAs(file);

    // Nouveau contexte = autre navigateur, IndexedDB vide.
    const context = await browser.newContext();
    const fresh = await context.newPage();
    await fresh.goto('/');
    await expect(fresh.getByText('Aucun camp pour l’instant')).toBeVisible();
    await fresh.getByTestId('campplan-input').setInputFiles(file);
    const dialog = fresh.getByTestId('import-project');
    await expect(dialog).toContainText('2 objets · 9 calques');
    await expect(dialog).toContainText('Camp test');
    await expect(fresh.getByTestId('import-verified')).toBeVisible();
    await fresh.getByRole('button', { name: 'Importer', exact: true }).click();
    await waitForBackground(fresh);
    await expect(fresh.getByTestId('plan-title')).toHaveText('Plan');
    expect(await storedObjects(fresh)).toEqual(before);
    await fresh.getByRole('tab', { name: 'Fond' }).click();
    await expect(fresh.getByTestId('bg-sha256')).toHaveText(sha256OfFile(fixture('quadrants.jpg')));
    const [original] = await Promise.all([
      fresh.waitForEvent('download'),
      fresh.getByRole('button', { name: 'Télécharger l’original' }).click(),
    ]);
    expect(sha256OfBuffer(readFileSync(await original.path()))).toBe(sha256OfFile(fixture('quadrants.jpg')));
    await context.close();
  });

  test('importer un plan déjà présent : copie sans écrasement ; remplacement seulement confirmé', async ({
    page,
  }) => {
    await openPlanWithPhoto(page);
    await page.keyboard.press('r');
    await dragOnCanvas(page, [300, 300], [450, 400]);
    await waitSaved(page);
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Exporter (.campplan)' }).click(),
    ]);
    const file = asciiTempPath('p.campplan');
    await download.saveAs(file);

    await page.getByRole('link', { name: 'Camps' }).first().click();
    await page.getByTestId('campplan-input').setInputFiles(file);
    const dialog = page.getByTestId('import-project');
    await expect(dialog).toContainText('Ce plan existe déjà');
    await expect(page.getByLabel('Nom du plan')).toHaveValue('Plan (importé)');
    await page.getByLabel('Remplacer le plan existant par celui du fichier').check();
    await expect(page.getByRole('button', { name: 'Remplacer le plan' })).toBeDisabled(); // confirmation requise
    await page.getByLabel('Importer comme une copie (le plan existant n’est pas touché)').check();
    await page.getByRole('button', { name: 'Importer', exact: true }).click();
    await waitForBackground(page);
    await page.getByRole('link', { name: 'Camp test' }).click();
    await expect(page.getByTestId('plan-row')).toHaveText([/^Plan(?! \()/, /^Plan \(importé\)/]);
  });

  test('fichier corrompu ou invalide : refusé avec un message clair, rien n’est créé', async ({ page }) => {
    await openPlanWithPhoto(page);
    await waitSaved(page);
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Exporter (.campplan)' }).click(),
    ]);
    const bytes = readFileSync((await download.path())!);
    const corrupted = Buffer.from(bytes);
    corrupted[Math.floor(corrupted.length / 3)] ^= 0xff; // un octet modifié dans la photo stockée
    const bad = asciiTempPath('corrompu.campplan');
    writeFileSync(bad, corrupted);
    const garbage = asciiTempPath('texte.campplan');
    writeFileSync(garbage, 'pas un projet');

    await page.getByRole('link', { name: 'Camps' }).first().click();
    for (const file of [bad, garbage]) {
      await page.getByTestId('campplan-input').setInputFiles(file);
      const error = page.getByRole('dialog', { name: 'Import impossible' });
      await expect(error).toContainText(/corrompu|illisible/);
      await error.getByRole('button', { name: 'Fermer' }).click();
    }
    await expect(page.getByTestId('camp-row')).toHaveCount(1);
  });
});

test.describe('calques', () => {
  test.beforeEach(async ({ page }) => {
    await openPlanWithPhoto(page);
    await page.getByRole('tab', { name: 'Calques' }).click();
  });

  test('créer, renommer, réordonner (le rendu suit), dupliquer, supprimer un calque vide', async ({
    page,
  }) => {
    await page.getByRole('button', { name: 'Nouveau calque' }).click();
    await page.getByLabel('Nom du calque').fill('Parking est');
    await page.getByRole('dialog').getByLabel('Catégorie').selectOption('zones');
    await page.getByRole('button', { name: 'Créer', exact: true }).click();
    await expect(page.getByTestId('layer-row').first()).toHaveAttribute('data-layer-name', 'Parking est');

    // Calque actif : le rectangle y va.
    await page.keyboard.press('r');
    await dragOnCanvas(page, [300, 300], [450, 400]);
    await page.getByRole('tab', { name: 'Calques' }).click();
    await expect(page.getByTestId('layer-row').first()).toContainText('1');

    await page.getByRole('button', { name: 'Renommer le calque Parking est' }).click();
    await page.getByLabel('Nom du calque').fill('Parking est employés');
    await page.getByRole('button', { name: 'Enregistrer' }).click();

    const top = (await renderedLayerOrder(page)).at(-1);
    await page.getByRole('button', { name: 'Descendre le calque Parking est employés' }).click();
    const order = await renderedLayerOrder(page);
    expect(order.at(-2)).toBe(top); // le rendu suit l'ordre des calques
    await expect(page.getByTestId('layer-row').nth(1)).toHaveAttribute(
      'data-layer-name',
      'Parking est employés',
    );

    await page.getByRole('button', { name: 'Dupliquer le calque Parking est employés' }).click();
    await expect.poll(async () => (await planNodes(page)).length).toBe(2);
    await expect(
      page.getByRole('button', { name: 'Supprimer le calque Parking est employés', exact: true }),
    ).toHaveCount(0);
    await page.getByRole('button', { name: 'Supprimer le calque Piétons' }).click();
    await expect(page.locator('[data-layer-name="Piétons"]')).toHaveCount(0);

    await waitSaved(page);
    await page.reload();
    await waitForBackground(page);
    await page.getByRole('tab', { name: 'Calques' }).click();
    await expect(page.getByTestId('layer-row').nth(1)).toHaveAttribute(
      'data-layer-name',
      'Parking est employés (copie)',
    );
  });

  test('afficher seulement un calque, puis tout afficher', async ({ page }) => {
    await page.keyboard.press('r');
    await dragOnCanvas(page, [300, 300], [450, 400]);
    await page.keyboard.press('l');
    await dragOnCanvas(page, [200, 500], [600, 550]);
    await page.getByRole('tab', { name: 'Calques' }).click();
    await page.getByRole('button', { name: 'Afficher seulement Zones' }).click();
    await expect.poll(async () => (await planNodes(page)).filter((n) => n.client.width > 0).length).toBe(1);
    const visible = await page.evaluate(
      () =>
        (
          window as unknown as { Konva: { stages: { find(s: string): { isVisible(): boolean }[] }[] } }
        ).Konva.stages[0]!.find('.plan-object').filter((n) => n.isVisible()).length,
    );
    expect(visible).toBe(1);
    await page.getByRole('button', { name: 'Tout afficher' }).click();
  });
});

test.describe('sélection multiple et groupes', () => {
  test.beforeEach(async ({ page }) => {
    await openPlanWithPhoto(page);
    await page.keyboard.press('r');
    await dragOnCanvas(page, [250, 250], [350, 320]);
    await page.keyboard.press('r');
    await dragOnCanvas(page, [450, 250], [550, 320]);
    await page.keyboard.press('e');
    await dragOnCanvas(page, [650, 250], [750, 320]);
    await page.keyboard.press('Escape');
  });

  test('Maj + clic, rectangle de sélection, Ctrl+A', async ({ page }) => {
    await clickOnCanvas(page, [300, 285]);
    await page.keyboard.down('Shift');
    await clickOnCanvas(page, [500, 285]);
    await page.keyboard.up('Shift');
    await expect(page.getByTestId('selection-count')).toHaveText('2 objets sélectionnés');
    await clickOnCanvas(page, [100, 150]);
    await dragOnCanvas(page, [200, 200], [580, 360]);
    await expect(page.getByTestId('selection-count')).toHaveText('2 objets sélectionnés');
    await page.keyboard.press('Control+a');
    await expect(page.getByTestId('selection-count')).toHaveText('3 objets sélectionnés');
  });

  test('déplacement de groupe = une seule action ; couleur, calque, suppression multiples', async ({
    page,
  }) => {
    await page.keyboard.press('Control+a');
    const before = await planNodes(page);
    await dragOnCanvas(page, [300, 285], [340, 325]);
    const after = await planNodes(page);
    for (const node of before) {
      const moved = after.find((n) => n.id === node.id)!;
      expect(moved.client.x - node.client.x).toBeCloseTo(40, 0);
    }
    await page.getByRole('button', { name: /Annuler \(Ctrl\+Z\)/ }).click();
    expect((await planNodes(page)).map((n) => n.client.x)).toEqual(before.map((n) => n.client.x));

    await page.getByRole('button', { name: 'Remplissage : Vert' }).click();
    await waitSaved(page);
    expect(
      Object.values(await storedObjects(page)).every((o) => (o.style as { fill: string }).fill === '#16a34a'),
    ).toBe(true);
    await page.getByLabel('Calque', { exact: true }).selectOption({ label: 'Bâtiments' });
    await waitSaved(page);
    const layers = new Set(Object.values(await storedObjects(page)).map((o) => o.layerId));
    expect(layers.size).toBe(1);
    await page.keyboard.press('Delete');
    await expect.poll(async () => (await planNodes(page)).length).toBe(0);
    await page.keyboard.press('Control+z');
    await expect.poll(async () => (await planNodes(page)).length).toBe(3);
  });

  test('grouper : un clic sélectionne tout le groupe ; dégrouper ; objet verrouillé jamais déplacé', async ({
    page,
  }) => {
    await clickOnCanvas(page, [300, 285]);
    await page.keyboard.down('Shift');
    await clickOnCanvas(page, [500, 285]);
    await page.keyboard.up('Shift');
    await page.keyboard.press('Control+g');
    await clickOnCanvas(page, [100, 150]);
    await clickOnCanvas(page, [300, 285]);
    await expect(page.getByTestId('selection-count')).toHaveText('Groupe de 2 objets');

    // Verrouiller l'ellipse, tout sélectionner, glisser : l'ellipse ne bouge pas.
    await clickOnCanvas(page, [700, 285]);
    await page.getByLabel('Verrouillé').check();
    const before = await planNodes(page);
    const locked = before.find((n) => n.className === 'Ellipse')!;
    await page.keyboard.press('Control+a');
    await page.keyboard.down('Shift');
    await clickOnCanvas(page, [700, 285]);
    await page.keyboard.up('Shift');
    await expect(page.getByTestId('selection-count')).toHaveText('3 objets sélectionnés');
    await dragOnCanvas(page, [300, 285], [340, 325]);
    const after = await planNodes(page);
    expect(after.find((n) => n.id === locked.id)!.client).toEqual(locked.client);
    expect(after.filter((n) => n.client.x !== before.find((b) => b.id === n.id)!.client.x)).toHaveLength(2);

    await clickOnCanvas(page, [340, 325]);
    await page.keyboard.press('Control+Shift+g');
    await clickOnCanvas(page, [100, 150]);
    await clickOnCanvas(page, [340, 325]);
    await expect(page.getByTestId('object-type')).toHaveText('Zone');
  });
});

test.describe('polygones et chemins', () => {
  test.beforeEach(async ({ page }) => {
    await openPlanWithPhoto(page);
  });

  const points = async (page: Page) =>
    (Object.values(await storedObjects(page))[0]!.geometry as Geo).points ?? [];

  test('insérer (glisser un « + »), supprimer un sommet ; annuler / rétablir ; sauvegarde', async ({
    page,
  }) => {
    await page.keyboard.press('p');
    for (const at of [
      [300, 200],
      [500, 200],
      [500, 400],
      [300, 400],
    ] as [number, number][])
      await clickOnCanvas(page, at);
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: 'Modifier les points' }).click();
    await waitSaved(page);
    expect(await points(page)).toHaveLength(4);

    // Milieu du segment haut (400, 200) : glisser vers le haut insère un 5e sommet.
    await dragOnCanvas(page, [400, 200], [400, 150]);
    await expect.poll(async () => (await points(page)).length).toBe(5);
    await page.getByRole('button', { name: /Annuler \(Ctrl\+Z\)/ }).click();
    await expect.poll(async () => (await points(page)).length).toBe(4);
    await page.keyboard.press('Control+y');
    await expect.poll(async () => (await points(page)).length).toBe(5);

    // Sélectionner le sommet ajouté puis Suppr.
    await clickOnCanvas(page, [400, 150]);
    await page.keyboard.press('Delete');
    await expect.poll(async () => (await points(page)).length).toBe(4);
    expect(await planNodes(page)).toHaveLength(1); // l'objet lui-même n'est pas supprimé

    await waitSaved(page);
    await page.reload();
    await waitForBackground(page);
    expect(await points(page)).toHaveLength(4);
  });

  test('fermer une polyligne en polygone ; convertir un rectangle en polygone', async ({ page }) => {
    await page.keyboard.press('k');
    for (const at of [
      [300, 200],
      [500, 220],
      [450, 400],
    ] as [number, number][])
      await clickOnCanvas(page, at);
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: 'Fermer en polygone' }).click();
    await expect(page.getByTestId('object-type')).toHaveText('Zone');
    await page.keyboard.press('Delete');

    await page.keyboard.press('r');
    await dragOnCanvas(page, [300, 300], [450, 400]);
    await page.getByRole('button', { name: 'Convertir en polygone (coins ajustables)' }).click();
    await waitSaved(page);
    const g = Object.values(await storedObjects(page))[0]!.geometry as Geo;
    expect(g.kind).toBe('polygon');
    expect(g.points).toHaveLength(4);
    // Coin ajustable directement.
    await dragOnCanvas(page, [300, 300], [280, 290]);
    await expect
      .poll(async () => (Object.values(await storedObjects(page))[0]!.geometry as Geo).points![0]!.x)
      .toBeLessThan(g.points![0]!.x);
  });
});

test('un plan de la version précédente (format 1) s’ouvre et reste modifiable', async ({ page }) => {
  await openFreshApp(page);
  await createCamp(page, 'Ancien');
  await createPlan(page, 'Plan v1');
  await importBackground(page, fixture('quadrants.png'));
  await waitForBackground(page);
  await page.keyboard.press('r');
  await dragOnCanvas(page, [300, 300], [450, 400]);
  await waitSaved(page);
  // Simule un enregistrement de phase 2 : format 1, sans groupId.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const open = indexedDB.open('campplanner');
        open.onsuccess = () => {
          const tx = open.result.transaction('plans', 'readwrite');
          const store = tx.objectStore('plans');
          const req = store.getAll();
          req.onsuccess = () => {
            const record = req.result[0] as {
              document: { schemaVersion: number; objects: Record<string, Record<string, unknown>> };
            };
            record.document.schemaVersion = 1;
            for (const o of Object.values(record.document.objects)) delete o.groupId;
            store.put(record);
          };
          tx.oncomplete = () => {
            open.result.close();
            resolve();
          };
        };
      }),
  );
  await page.reload();
  await waitForBackground(page);
  expect(await planNodes(page)).toHaveLength(1);
  await clickOnCanvas(page, [375, 350]);
  await page.keyboard.press('ArrowRight');
  await waitSaved(page);
  expect(Object.values(await storedObjects(page))[0]!.groupId).toBeNull();
});

test('petit objet : le glisser depuis son centre le déplace, sans le redimensionner', async ({ page }) => {
  await openPlanWithPhoto(page);
  await page.keyboard.press('r');
  await dragOnCanvas(page, [300, 300], [318, 311]); // 18 × 11 px à l'écran, reste sélectionné
  await clickOnCanvas(page, [100, 150]);
  await clickOnCanvas(page, [309, 305.5]); // sélection par clic, comme un utilisateur
  const [before] = await planNodes(page);
  // Trajet réaliste : la main part aussi un peu vers le haut ou le bas.
  const box = (await page.getByTestId('canvas-container').boundingBox())!;
  await page.mouse.move(box.x + 309, box.y + 305.5);
  await page.mouse.down();
  for (let i = 1; i <= 20; i++)
    await page.mouse.move(box.x + 309 + i * 3, box.y + 305.5 + Math.sin(i / 5) * 20);
  await page.mouse.up();
  const [after] = await planNodes(page);
  expect(after!.client.x - before!.client.x).toBeCloseTo(60, 0);
  expect(after!.client.y - before!.client.y).toBeCloseTo(Math.sin(4) * 20, 0);
  expect(after!.client.width).toBeCloseTo(before!.client.width, 1);
  expect(after!.client.height).toBeCloseTo(before!.client.height, 1);
});
