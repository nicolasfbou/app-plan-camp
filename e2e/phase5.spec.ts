import { readFileSync } from 'node:fs';
import { type Browser, type Page, expect, test } from '@playwright/test';
// Inspection des PDF produits avec pdf.js (outil partagé avec la démonstration Camp 105).
// @ts-expect-error module JavaScript sans déclarations de types
import { inspectPdf } from '../bench/pdf-inspect.mjs';
import {
  asciiTempPath,
  clickOnCanvas,
  dragOnCanvas,
  fixture,
  openPlanWithPhoto,
  settledTransform,
  sha256OfBuffer,
  sha256OfFile,
  waitSaved,
} from './helpers.ts';

type Pt = { x: number; y: number };
type Doc = {
  plan: Record<string, unknown> & {
    calibration: { p1: Pt; p2: Pt; distanceMeters: number } | null;
    northStatus: string;
    northAngleDeg: number;
    titleBlock: Record<string, unknown>;
    legend: Record<string, unknown>;
    print: Record<string, unknown>;
  };
  objects: Record<
    string,
    Record<string, unknown> & { id: string; type: string; geometry: Record<string, unknown> }
  >;
  layers: { id: string; name: string; tier: string }[];
  assets: Record<string, unknown>;
};

const storedDocument = async (page: Page) => {
  await waitSaved(page);
  return page.evaluate(
    () =>
      new Promise<Doc>((resolve) => {
        const open = indexedDB.open('campplanner');
        open.onsuccess = () => {
          const r = open.result.transaction('plans').objectStore('plans').getAll();
          r.onsuccess = () => {
            resolve((r.result[0] as { document: Doc }).document);
            open.result.close();
          };
        };
      }),
  );
};

/** Point écran du canevas → pixels image (même conversion que l'application). */
async function toImage(page: Page, at: [number, number]): Promise<Pt> {
  const t = await settledTransform(page);
  return { x: (at[0] - t.x) / t.scale, y: (at[1] - t.y) / t.scale };
}

async function calibrate(page: Page, a: [number, number], b: [number, number], meters: string) {
  await page.getByRole('tab', { name: 'Fond' }).click();
  await page.getByRole('button', { name: /^(Calibrer \(2 points\)|Refaire la calibration)$/ }).click();
  await clickOnCanvas(page, a);
  await clickOnCanvas(page, b);
  const dialog = page.getByRole('dialog', { name: 'Calibrer la photo' });
  await dialog.getByLabel('Distance réelle entre ces points (m)').fill(meters);
  await dialog.getByRole('button', { name: 'Calibrer' }).click();
  await expect(dialog).toBeHidden();
}

async function openPrint(page: Page) {
  await page.getByTestId('open-print').click();
  await expect(page.getByTestId('print-dialog')).toBeVisible();
  await expect(page.getByTestId('print-warnings')).toContainText('À vérifier');
}

async function exportFile(page: Page) {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('print-export').click(),
  ]);
  return { name: download.suggestedFilename(), bytes: readFileSync((await download.path())!) };
}

/** Pixel RGBA d'une image PNG / JPG décodée par le navigateur. */
async function imagePixel(page: Page, bytes: Buffer, mime: string, x: number, y: number) {
  return page.evaluate(
    async ({ data, mime, x, y }) => {
      const bitmap = await createImageBitmap(new Blob([new Uint8Array(data)], { type: mime }));
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const c = canvas.getContext('2d')!;
      c.drawImage(bitmap, 0, 0);
      return { width: bitmap.width, height: bitmap.height, rgba: [...c.getImageData(x, y, 1, 1).data] };
    },
    { data: [...bytes], mime, x, y },
  );
}

async function pdfOf(browser: Browser, bytes: Buffer) {
  return (await inspectPdf(browser, bytes)) as {
    pages: number;
    widthMm: number;
    heightMm: number;
    text: string;
    fonts: string[];
    operators: Record<string, number>;
  };
}

test.describe('Phase 5 — calibration et mesures', () => {
  test('calibration en 2 clics, mesures en m / pieds, retour aux pixels sans calibration', async ({
    page,
  }) => {
    await openPlanWithPhoto(page);
    // Sans calibration : cote en pixels.
    await page.keyboard.press('m');
    await clickOnCanvas(page, [300, 300]);
    await clickOnCanvas(page, [700, 300]);
    await page.keyboard.press('Enter');
    await page.getByRole('tab', { name: 'Propriétés' }).click();
    await expect(page.getByTestId('measure-length')).toHaveText(/^\d[\d\s ]* px$/);
    await page.keyboard.press('Escape');

    // Calibration : ces deux mêmes points valent 20 m (virgule française acceptée).
    await calibrate(page, [300, 400], [700, 400], '20,0');
    const doc = await storedDocument(page);
    expect(doc.plan.calibration!.distanceMeters).toBe(20);
    await expect(page.getByTestId('calibration-status')).toContainText('20');

    const dim = Object.values(doc.objects).find((o) => o.type === 'dimension')!;
    await page.getByRole('tab', { name: 'Calques' }).click();
    await page.getByRole('button', { name: 'Cote', exact: true }).click();
    await page.getByRole('tab', { name: 'Propriétés' }).click();
    // 400 px écran = 20 m : arrondi honnête (pas de décimales inventées).
    await expect(page.getByTestId('measure-length')).toHaveText(/^≈ 20(,0)? m$/);
    expect(dim.type).toBe('dimension');

    // Pieds.
    await page.getByRole('tab', { name: 'Fond' }).click();
    await page.getByLabel('Unités d’affichage').selectOption('imperial');
    await page.getByRole('tab', { name: 'Propriétés' }).click();
    await expect(page.getByTestId('measure-length')).toHaveText(/^≈ 6[56](,\d)? pi$/);

    // Zone : périmètre et surface.
    await page.keyboard.press('Escape');
    await page.getByRole('tab', { name: 'Fond' }).click();
    await page.getByLabel('Unités d’affichage').selectOption('metric');
    await page.keyboard.press('r');
    await dragOnCanvas(page, [300, 500], [500, 600]);
    await page.getByRole('tab', { name: 'Propriétés' }).click();
    await expect(page.getByTestId('measure-area')).toHaveText(/^≈ 50(,0)? m²$/);
    await expect(page.getByTestId('measure-perimeter')).toHaveText(/^≈ 30(,0)? m$/);

    // Suppression de la calibration : retour aux pixels, jamais de fausse échelle.
    await page.getByRole('tab', { name: 'Fond' }).click();
    await page.getByRole('button', { name: 'Supprimer la calibration' }).click();
    await page.getByRole('tab', { name: 'Propriétés' }).click();
    await expect(page.getByTestId('measure-area')).toHaveText(/px²$/);
  });

  test('corridor en mètres : largeur physique stable, suit la calibration ; corridor en pixels inchangé', async ({
    page,
  }) => {
    await openPlanWithPhoto(page);
    await calibrate(page, [300, 400], [700, 400], '20');
    const bandHeight = (id: string) =>
      page.evaluate((id) => {
        const stage = (
          window as unknown as {
            Konva: {
              stages: { findOne(s: string): { getClientRect(o: object): { height: number } } | undefined }[];
            };
          }
        ).Konva.stages[0]!;
        return stage.findOne(`#${id}`)!.getClientRect({ skipStroke: true, skipShadow: true }).height;
      }, id);

    const drawCorridor = async (y: number) => {
      await page.getByRole('button', { name: 'Corridor piéton', exact: true }).click();
      await clickOnCanvas(page, [350, y]);
      await page.waitForTimeout(500); // deux clics rapprochés = double clic (fin du tracé)
      await clickOnCanvas(page, [750, y]);
      await page.waitForTimeout(500);
      await page.keyboard.press('Enter');
      await page.getByRole('tab', { name: 'Propriétés' }).click();
      await expect(page.getByTestId('object-type')).toHaveText('Corridor piéton');
    };
    // Premier corridor : largeur physique (2 m). Second : largeur en pixels.
    await drawCorridor(250);
    await page.getByLabel('Largeur définie en').selectOption('meters');
    const meters = page.getByLabel('Largeur (m)', { exact: true });
    await meters.fill('2');
    await meters.press('Enter');
    await page.keyboard.press('Escape');
    await drawCorridor(650);
    await page.keyboard.press('Escape');
    let doc = await storedDocument(page);
    const selectedId = Object.values(doc.objects).find(
      (o) => o.type === 'corridor' && o.widthMeters === 2,
    )!.id;
    const otherId = Object.values(doc.objects).find((o) => o.type === 'corridor' && o.id !== selectedId)!.id;
    const otherWidth = doc.objects[otherId]!.width;
    const scale = (await settledTransform(page)).scale;
    // 2 m à 20 m / 400 px écran : 40 px écran.
    // Rectangle englobant à l'écran : 2 m = 40 px écran.
    expect(await bandHeight(selectedId)).toBeCloseTo(40, 0);
    void scale;

    // Recalibration : ces points valent maintenant 40 m → le corridor physique est deux fois moins large
    // en pixels ; le corridor défini en pixels ne change pas.
    await page.keyboard.press('Escape');
    await calibrate(page, [300, 400], [700, 400], '40');
    doc = await storedDocument(page);
    expect(doc.objects[selectedId]!.widthMeters).toBe(2);
    expect(doc.objects[otherId]!.width).toBe(otherWidth);
    expect(doc.objects[otherId]!.widthMeters).toBeNull();
    await expect.poll(() => bandHeight(selectedId)).toBeCloseTo(20, 0);

    // Après rechargement : même largeur physique, même rendu.
    await page.reload();
    await expect(page.getByTestId('navigation-controls')).toBeVisible();
    await expect.poll(() => bandHeight(selectedId)).toBeCloseTo(20, 0);
  });
});

test.describe('Phase 5 — cases de stationnement', () => {
  test('génération dans une zone, nombre affiché, cases dans le contour, supprimables et déplaçables', async ({
    page,
  }) => {
    await openPlanWithPhoto(page);
    await page.locator('[data-preset="zone.parking"]').click();
    await dragOnCanvas(page, [300, 250], [800, 550]);
    await page.getByRole('tab', { name: 'Propriétés' }).click();
    const zoneDoc = await storedDocument(page);
    const zone = Object.values(zoneDoc.objects).find((o) => o.type === 'zone')!;
    const g = zone.geometry as { x: number; y: number; width: number; height: number };
    for (const [label, value] of [
      ['Largeur de case (px)', '20'],
      ['Longueur de case (px)', '45'],
      ['Rangées', '2'],
      ['Allée entre rangées (px)', '30'],
    ]) {
      const field = page.getByLabel(label!, { exact: true });
      await field.fill(value!);
      await field.press('Enter');
    }
    await page.getByRole('button', { name: 'Générer les cases' }).click();
    const doc = await storedDocument(page);
    const stalls = Object.values(doc.objects).filter((o) => o.type === 'stall');
    expect(stalls.length).toBeGreaterThan(4);
    await expect(page.getByTestId('stall-count')).toContainText(`${stalls.length} case`);
    for (const s of stalls) {
      const r = s.geometry as { x: number; y: number; width: number; height: number };
      expect(s.parentZoneId).toBe(zone.id);
      expect(r.x).toBeGreaterThanOrEqual(g.x - 1e-6);
      expect(r.y).toBeGreaterThanOrEqual(g.y - 1e-6);
      expect(r.x + r.width).toBeLessThanOrEqual(g.x + g.width + 1e-6);
      expect(r.y + r.height).toBeLessThanOrEqual(g.y + g.height + 1e-6);
    }

    // Une case sélectionnée seule : déplacée puis supprimée, sans toucher aux autres.
    await page.keyboard.press('Escape');
    const target = stalls[0]!;
    const r = target.geometry as { x: number; y: number; width: number; height: number };
    const t = await settledTransform(page);
    const box = (await page.getByTestId('canvas-container').boundingBox())!;
    const at: [number, number] = [(r.x + r.width / 2) * t.scale + t.x, (r.y + r.height / 2) * t.scale + t.y];
    await page.mouse.click(box.x + at[0], box.y + at[1]);
    await expect(page.getByText('Case générée dans')).toBeVisible();
    await dragOnCanvas(page, at, [at[0] + 30, at[1]]);
    let after = await storedDocument(page);
    const moved = Object.values(after.objects).filter((o) => o.type === 'stall');
    expect(moved).toHaveLength(stalls.length);
    const changed = moved.filter(
      (s) => JSON.stringify(s.geometry) !== JSON.stringify(stalls.find((x) => x.id === s.id)!.geometry),
    );
    expect(changed).toHaveLength(1);
    await page.keyboard.press('Delete');
    after = await storedDocument(page);
    expect(Object.values(after.objects).filter((o) => o.type === 'stall')).toHaveLength(stalls.length - 1);
    expect(after.objects[zone.id]).toBeTruthy();
  });
});

test.describe('Phase 5 — plan professionnel et exports', () => {
  test('nord manuel, cartouche, approbation explicite, légende, aperçu et PDF vectoriel', async ({
    page,
    browser,
  }) => {
    await openPlanWithPhoto(page);
    await page.getByRole('button', { name: 'Circulation véhicules', exact: true }).first().click();
    await page.locator('[data-flow-category="light"]').click();
    await clickOnCanvas(page, [100, 150]);
    await page.waitForTimeout(500); // deux clics rapprochés = double clic (fin du tracé)
    await clickOnCanvas(page, [650, 150]);
    await page.waitForTimeout(500);
    await page.keyboard.press('Enter');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Rectangle', exact: true }).click();
    await page.locator('[data-preset="zone.parking"]').click();
    await dragOnCanvas(page, [350, 450], [600, 600]);
    await page.keyboard.press('Escape');

    // Nord : non défini par défaut ; orienté à la main (2 clics), jamais supposé.
    let doc = await storedDocument(page);
    expect(doc.plan.northStatus).toBe('undefined');
    await page.getByRole('tab', { name: 'Fond' }).click();
    await page.getByRole('button', { name: 'Orienter le nord (2 points)' }).click();
    const a = await toImage(page, [500, 500]);
    await clickOnCanvas(page, [500, 500]);
    await clickOnCanvas(page, [600, 400]);
    const b = await toImage(page, [600, 400]);
    doc = await storedDocument(page);
    expect(doc.plan.northStatus).toBe('estimated');
    expect(doc.plan.northAngleDeg).toBeCloseTo((Math.atan2(b.x - a.x, a.y - b.y) * 180) / Math.PI, 0);
    await expect(page.getByTestId('north-status')).toContainText('à vérifier');

    await openPrint(page);
    const warnings = page.getByTestId('print-warnings');
    await expect(warnings.locator('[data-warning="not-calibrated"]')).toBeVisible();
    await expect(warnings.locator('[data-warning="north-estimated"]')).toBeVisible();
    // Légende : seulement les catégories présentes.
    const entries = page.getByTestId('legend-entries').locator('li');
    await expect(entries).toHaveCount(2);

    // Approbation : impossible sans nom ni confirmation explicite.
    const settings = page.getByTestId('print-settings');
    await settings.getByRole('combobox', { name: 'Statut', exact: true }).selectOption('approved');
    const approve = page.getByRole('dialog', { name: 'Approuver le plan' });
    await expect(approve.getByRole('button', { name: 'Approuver' })).toBeDisabled();
    await approve.getByLabel('Nom de l’approbateur').fill('A. Tremblay');
    await expect(approve.getByRole('button', { name: 'Approuver' })).toBeDisabled();
    await approve.getByRole('button', { name: 'Annuler' }).click();
    doc = await storedDocument(page);
    expect(doc.plan.titleBlock.status).toBe('draft');
    await settings.getByRole('combobox', { name: 'Statut', exact: true }).selectOption('approved');
    await approve.getByLabel('Nom de l’approbateur').fill('A. Tremblay');
    await approve.getByLabel('Je confirme être autorisé(e) à approuver ce plan.').check();
    await approve.getByRole('button', { name: 'Approuver' }).click();
    await expect(page.getByTestId('approval-info')).toContainText('A. Tremblay');

    await settings.getByRole('textbox', { name: 'Titre du plan', exact: true }).fill('Plan test Phase 5');
    await settings.getByRole('textbox', { name: 'Numéro de plan', exact: true }).fill('P5-001');
    // Intitulé personnalisé d'une entrée de légende.
    await page
      .getByTestId('legend-entries')
      .locator('li')
      .first()
      .locator('input')
      .nth(1)
      .fill('Voie principale');

    // Aperçu non vide.
    await expect
      .poll(() =>
        page.getByTestId('print-preview').evaluate((c: HTMLCanvasElement) => {
          const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
          let dark = 0;
          for (let i = 0; i < d.length; i += 4 * 97) if (d[i]! < 100) dark++;
          return dark;
        }),
      )
      .toBeGreaterThan(50);

    // PDF Tabloïd paysage (par défaut) : vectoriel, police intégrée, textes exacts.
    const pdf = await exportFile(page);
    expect(pdf.name).toBe('P5-001-revA.pdf');
    const info = await pdfOf(browser, pdf.bytes);
    expect(info.pages).toBe(1);
    expect(info.widthMm).toBeCloseTo(431.8, 0);
    expect(info.heightMm).toBeCloseTo(279.4, 0);
    expect(info.fonts).toContain('LiberationSans');
    expect(info.operators.constructPath).toBeGreaterThan(10);
    expect(info.operators.paintImageXObject).toBeGreaterThanOrEqual(1);
    for (const s of [
      'Plan test Phase 5',
      'Voie principale',
      'Légende',
      'A. Tremblay',
      'Approuvé',
      'Plan non calibré',
      'à vérifier',
    ])
      expect(info.text).toContain(s);

    // Lettre portrait, plan simplifié : pas de cartouche.
    await settings.getByRole('combobox', { name: 'Format', exact: true }).selectOption('letter');
    await settings.getByRole('combobox', { name: 'Orientation', exact: true }).selectOption('portrait');
    await settings.getByRole('combobox', { name: 'Contenu', exact: true }).selectOption('simplified');
    await expect(page.getByTestId('page-info')).toContainText('Lettre');
    const simple = await pdfOf(browser, (await exportFile(page)).bytes);
    expect(simple.widthMm).toBeCloseTo(215.9, 0);
    expect(simple.heightMm).toBeCloseTo(279.4, 0);
    expect(simple.text).not.toContain('A. Tremblay');

    // Sélection des calques : sans le calque des zones, ni la zone ni son entrée de légende.
    const zonesLayer = doc.layers.find((l) =>
      Object.values(doc.objects).some((o) => o.type === 'zone' && o.layerId === l.id),
    )!;
    await page.getByTestId('print-layers').getByLabel(zonesLayer.name, { exact: true }).uncheck();
    await expect(entries).toHaveCount(1);
    const noZones = await pdfOf(browser, (await exportFile(page)).bytes);
    expect(noZones.text).not.toContain('Stationnement');

    // Réglages enregistrés dans le plan, conservés après rechargement.
    await page.getByRole('button', { name: 'Fermer' }).first().click();
    doc = await storedDocument(page);
    expect(doc.plan.print).toMatchObject({ paper: 'letter', orientation: 'portrait', mode: 'simplified' });
    expect((doc.plan.print.excludedLayerIds as string[]).includes(zonesLayer.id)).toBe(true);
    await page.reload();
    await expect(page.getByTestId('navigation-controls')).toBeVisible();
    doc = await storedDocument(page);
    expect(doc.plan.titleBlock.status).toBe('approved');
  });

  test('PNG / JPG : résolution d’origine, PNG transparent sans fond, limite claire, original intact', async ({
    page,
  }) => {
    await openPlanWithPhoto(page);
    await page.getByRole('button', { name: 'Circulation véhicules', exact: true }).first().click();
    await page.locator('[data-flow-category="light"]').click();
    await clickOnCanvas(page, [100, 150]);
    await page.waitForTimeout(500); // deux clics rapprochés = double clic (fin du tracé)
    await clickOnCanvas(page, [650, 150]);
    await page.waitForTimeout(500);
    await page.keyboard.press('Enter');
    await page.keyboard.press('Escape');
    await openPrint(page);
    const settings = page.getByTestId('print-settings');

    // PNG plan seul, résolution d'origine, sans légende ni cartouche ni titre : exactement la photo.
    await page.getByRole('radio', { name: 'PNG' }).click();
    await settings.getByLabel('Cadrage de l’image').selectOption('image');
    for (const name of ['Bandeau de titre', 'Légende', 'Cartouche'])
      await settings.getByRole('checkbox', { name, exact: true }).uncheck();
    await expect(page.getByTestId('raster-size')).toContainText('320 × 200 px');
    let file = await exportFile(page);
    expect(file.name.endsWith('.png')).toBe(true);
    let px = await imagePixel(page, file.bytes, 'image/png', 5, 5);
    expect([px.width, px.height]).toEqual([320, 200]);
    expect(px.rgba[3]).toBe(255);

    // Légende et cartouche à côté du plan : la photo n'est jamais recouverte, l'image s'élargit.
    await settings.getByRole('checkbox', { name: 'Légende', exact: true }).check();
    await settings.getByRole('checkbox', { name: 'Cartouche', exact: true }).check();
    file = await exportFile(page);
    px = await imagePixel(page, file.bytes, 'image/png', 0, 0);
    expect(px.width).toBeGreaterThan(320);

    // Plan sans fond, fond transparent : PNG avec transparence.
    for (const name of ['Légende', 'Cartouche'])
      await settings.getByRole('checkbox', { name, exact: true }).uncheck();
    await settings.getByRole('combobox', { name: 'Contenu', exact: true }).selectOption('annotations');
    await settings.getByLabel('Fond de page').selectOption('transparent');
    file = await exportFile(page);
    px = await imagePixel(page, file.bytes, 'image/png', 2, 190);
    expect(px.rgba[3]).toBe(0);

    // JPG : fond blanc, qualité réglable.
    await page.getByRole('radio', { name: 'JPG' }).click();
    file = await exportFile(page);
    expect(file.name.endsWith('.jpg')).toBe(true);
    expect([...file.bytes.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);

    // Résolution trop grande : message clair et proposition d'une résolution qui passe.
    await settings.getByLabel('Cadrage de l’image').selectOption('page');
    await settings.getByRole('combobox', { name: 'Format', exact: true }).selectOption('a1');
    const dpi = settings.getByLabel('Résolution (ppp)');
    await dpi.fill('600');
    await dpi.press('Enter');
    await page.getByTestId('print-export').click();
    const result = page.getByTestId('print-result');
    await expect(result).toContainText('trop grande pour le navigateur');
    await result.getByRole('button', { name: /^Utiliser/ }).click();
    await expect(dpi).not.toHaveValue('600');
    const lowered = await exportFile(page);
    expect(lowered.bytes.length).toBeGreaterThan(1000);

    // La photo d'origine n'a jamais été modifiée.
    await page.getByRole('button', { name: 'Fermer' }).first().click();
    await page.getByRole('tab', { name: 'Fond' }).click();
    const [original] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Télécharger l’original' }).click(),
    ]);
    expect(sha256OfBuffer(readFileSync((await original.path())!))).toBe(
      sha256OfFile(fixture('quadrants.png')),
    );
  });

  test('.campplan : réglages, cartouche et logo conservés à l’export et au réimport', async ({
    page,
    browser,
  }) => {
    await openPlanWithPhoto(page);
    await calibrate(page, [300, 400], [700, 400], '20');
    await openPrint(page);
    const settings = page.getByTestId('print-settings');
    await page.getByTestId('logo-input').setInputFiles(fixture('quadrants.png'));
    await expect(settings.getByRole('button', { name: /Logo — quadrants/ })).toBeVisible();
    await settings.getByRole('textbox', { name: 'Client', exact: true }).fill('Client test');
    await settings.getByRole('combobox', { name: 'Position', exact: true }).selectOption('bottom-right');
    await settings
      .getByRole('combobox', { name: 'Position du cartouche', exact: true })
      .selectOption('bottom');
    await page.getByRole('button', { name: 'Fermer' }).first().click();
    const before = await storedDocument(page);
    expect(before.plan.titleBlock.logoAssetId).toBeTruthy();

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Exporter (.campplan)' }).click(),
    ]);
    const archive = asciiTempPath('p5.campplan');
    await download.saveAs(archive);

    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    const fresh = await context.newPage();
    await fresh.goto('/');
    await fresh.getByTestId('campplan-input').setInputFiles(archive);
    await expect(fresh.getByTestId('import-verified')).toBeVisible({ timeout: 30_000 });
    await fresh.getByRole('button', { name: 'Importer', exact: true }).click();
    await expect(fresh.getByTestId('navigation-controls')).toBeVisible({ timeout: 30_000 });
    const after = await storedDocument(fresh);
    for (const key of ['legend', 'print', 'calibration', 'northStatus', 'units'])
      expect(after.plan[key]).toEqual(before.plan[key]);
    expect(after.plan.titleBlock).toEqual(before.plan.titleBlock);
    expect(after.assets[after.plan.titleBlock.logoAssetId as string]).toBeTruthy();
    // Le logo du cartouche apparaît dans l'aperçu du plan réimporté (sans erreur).
    await openPrint(fresh);
    await expect(fresh.getByTestId('print-warnings')).not.toContainText('Aperçu impossible');
    await context.close();
  });
});
