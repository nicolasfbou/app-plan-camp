import { expect, test } from '@playwright/test';
import {
  canvasBox,
  clickOnCanvas,
  dragOnCanvas,
  openPlanWithPhoto,
  planNodes,
  settledTransform,
  storedObjects,
  waitSaved,
} from './helpers.ts';

type Geo = {
  kind: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  points?: { x: number; y: number }[];
};

test.beforeEach(async ({ page }) => {
  await openPlanWithPhoto(page);
});

test('parcours 1 : rectangle → déplacer → redimensionner → couleur → sauvegarde → rechargement', async ({
  page,
}) => {
  await page.getByRole('radio', { name: 'Stationnement' }).click();
  await dragOnCanvas(page, [300, 300], [500, 420]);
  await expect(page.getByTestId('object-type')).toHaveText('Zone');
  await expect(page.getByLabel('Nom', { exact: true })).toHaveValue('Stationnement');
  await expect(page.getByTestId('canvas-container')).toHaveAttribute('data-tool', 'select');

  let [node] = await planNodes(page);
  const created = { ...node! };
  // Déplacer : glisser l'objet.
  await dragOnCanvas(page, [400, 360], [460, 380]);
  [node] = await planNodes(page);
  expect(node!.client.x - created.client.x).toBeCloseTo(60, 0);
  expect(node!.client.y - created.client.y).toBeCloseTo(20, 0);

  // Redimensionner par la poignée bas-droite : l'échelle est intégrée à la géométrie.
  const anchor = await page.evaluate(() => {
    const tr = (
      window as never as {
        Konva: {
          stages: {
            findOne(s: string): {
              findOne(s: string): {
                getClientRect(): { x: number; y: number; width: number; height: number };
              };
            };
          }[];
        };
      }
    ).Konva.stages[0]!.findOne('Transformer');
    const r = tr.findOne('.bottom-right').getClientRect();
    return [r.x + r.width / 2, r.y + r.height / 2] as [number, number];
  });
  await dragOnCanvas(page, anchor, [anchor[0] + 100, anchor[1] + 60]);
  [node] = await planNodes(page);
  expect(node!.scaleX).toBe(1);
  expect(node!.scaleY).toBe(1);
  expect(node!.client.width).toBeCloseTo(created.client.width + 100, 0);

  // Couleur rapide + opacité.
  await page.getByRole('button', { name: 'Remplissage : Rouge' }).click();
  await waitSaved(page);
  const saved = Object.values(await storedObjects(page))[0]!;
  expect((saved.style as { fill: string }).fill).toBe('#dc2626');
  const geometry = saved.geometry as Geo;

  await page.reload();
  await expect(page.getByTestId('navigation-controls')).toBeVisible();
  const reopened = Object.values(await storedObjects(page))[0]!;
  expect(reopened.geometry).toEqual(geometry);
  expect(reopened).not.toHaveProperty('scaleX');
  await expect.poll(async () => (await planNodes(page)).length).toBe(1);
});

test('parcours 2 : polygone → modifier un sommet → rotation → annuler → rétablir', async ({ page }) => {
  await page.keyboard.press('p');
  for (const at of [
    [300, 200],
    [450, 220],
    [430, 380],
    [280, 330],
  ] as [number, number][])
    await clickOnCanvas(page, at);
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('object-type')).toHaveText('Zone');
  await expect
    .poll(async () => ((Object.values(await storedObjects(page))[0]?.geometry as Geo)?.points ?? []).length)
    .toBe(4);
  const geo = Object.values(await storedObjects(page))[0]!;
  const original = (geo.geometry as Geo).points!;

  // Modifier les points : glisser le premier sommet de 40 px à droite.
  await page.getByRole('button', { name: 'Modifier les points' }).click();
  await dragOnCanvas(page, [300, 200], [340, 200]);
  await expect
    .poll(async () => (Object.values(await storedObjects(page))[0]!.geometry as Geo).points![0]!.x)
    .toBeGreaterThan(original[0]!.x);
  const scale = (await settledTransform(page)).scale;
  const moved = (Object.values(await storedObjects(page))[0]!.geometry as Geo).points!;
  expect(moved[0]!.x - original[0]!.x).toBeCloseTo(40 / scale, 0);
  expect(moved.slice(1)).toEqual(original.slice(1));
  await page.keyboard.press('Escape'); // quitte la modification des points

  // Rotation par le panneau (une action).
  await page.getByLabel('Rotation (°)').fill('30');
  await page.getByLabel('Rotation (°)').press('Enter');
  await expect.poll(async () => (await planNodes(page))[0]!.rotation).toBeCloseTo(30);

  const undo = page.getByRole('button', { name: /Annuler \(Ctrl\+Z\)/ });
  await undo.click();
  await expect.poll(async () => (await planNodes(page))[0]!.rotation).toBe(0);
  await undo.click(); // annule la modification du sommet (un seul geste = une action)
  await expect
    .poll(async () => (Object.values(await storedObjects(page))[0]!.geometry as Geo).points)
    .toEqual(original);
  await page.keyboard.press('Control+y');
  await page.keyboard.press('Control+y');
  await expect.poll(async () => (await planNodes(page))[0]!.rotation).toBeCloseTo(30);
});

test('parcours 3 : texte → double clic → modifier le texte → rechargement', async ({ page }) => {
  await page.keyboard.press('t');
  await clickOnCanvas(page, [400, 300]);
  const editor = page.getByTestId('text-editor');
  await expect(editor).toBeFocused();
  await editor.fill('DORTOIR 1');
  await editor.press('Enter');
  await expect(editor).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Texte', exact: true })).toHaveValue('DORTOIR 1');

  // Double clic sur le texte : édition directe sur le plan.
  const [node] = await planNodes(page);
  const box = await canvasBox(page);
  await page.mouse.dblclick(
    box.x + node!.client.x + node!.client.width / 2,
    box.y + node!.client.y + node!.client.height / 2,
  );
  await expect(editor).toBeFocused();
  await editor.fill('CUISINE / CAFÉTÉRIA');
  await editor.press('Enter');
  await waitSaved(page);

  await page.reload();
  await expect(page.getByTestId('navigation-controls')).toBeVisible();
  await expect
    .poll(async () => Object.values(await storedObjects(page))[0]?.text)
    .toBe('CUISINE / CAFÉTÉRIA');
  // Échap annule une édition en cours.
  const [n2] = await planNodes(page);
  await page.mouse.dblclick(
    box.x + n2!.client.x + n2!.client.width / 2,
    box.y + n2!.client.y + n2!.client.height / 2,
  );
  await editor.fill('NE PAS GARDER');
  await editor.press('Escape');
  await expect(page.getByRole('textbox', { name: 'Texte', exact: true })).toHaveValue('CUISINE / CAFÉTÉRIA');
});

test('parcours 4 : verrouiller → impossible à déplacer ou supprimer → déverrouiller → déplacer', async ({
  page,
}) => {
  await dragOnCanvas(page, [300, 300], [450, 400]); // outil Sélection : rien n'est créé
  expect(await planNodes(page)).toHaveLength(0);
  await page.keyboard.press('r');
  await dragOnCanvas(page, [300, 300], [450, 400]);
  await page.getByLabel('Verrouillé').check();
  const [before] = await planNodes(page);

  await dragOnCanvas(page, [370, 350], [470, 420]);
  await page.keyboard.press('Delete');
  await page.keyboard.press('ArrowRight');
  const [locked] = await planNodes(page);
  expect(locked!.client).toEqual(before!.client);
  await expect(page.getByLabel('Largeur')).toBeDisabled();

  await page.getByLabel('Verrouillé').uncheck();
  await dragOnCanvas(page, [370, 350], [470, 420]);
  const [after] = await planNodes(page);
  expect(after!.client.x - before!.client.x).toBeCloseTo(100, 0);
});

test('calque verrouillé et calque masqué', async ({ page }) => {
  await page.keyboard.press('r');
  await dragOnCanvas(page, [300, 300], [450, 400]);
  await page.getByRole('tab', { name: 'Calques' }).click();
  await page.getByRole('button', { name: 'Verrouiller le calque Zones' }).click();
  await clickOnCanvas(page, [100, 100]); // désélectionne
  await dragOnCanvas(page, [370, 350], [470, 420]);
  const [node] = await planNodes(page);
  expect(node!.client.x).toBeCloseTo(300, -1);
  await page.getByRole('button', { name: 'Masquer le calque Zones' }).click();
  await expect.poll(async () => (await planNodes(page)).length).toBe(0);
  await page.getByRole('button', { name: 'Afficher le calque Zones' }).click();
  await expect.poll(async () => (await planNodes(page)).length).toBe(1);
});

test('parcours 5 : plusieurs objets → ordre → dupliquer → copier/coller → supprimer → annuler', async ({
  page,
}) => {
  await page.keyboard.press('r');
  await dragOnCanvas(page, [300, 300], [450, 400]);
  await page.keyboard.press('e');
  await dragOnCanvas(page, [350, 330], [520, 440]);
  const ids = (await planNodes(page)).map((n) => n.id);
  expect(ids).toHaveLength(2);

  // L'ellipse (sélectionnée) passe à l'arrière-plan de son calque.
  await page.getByRole('button', { name: 'À l’arrière-plan' }).click();
  await expect.poll(async () => (await planNodes(page)).map((n) => n.id)).toEqual([ids[1], ids[0]]);

  await page.keyboard.press('Control+d');
  await expect.poll(async () => (await planNodes(page)).length).toBe(3);
  const nodes = await planNodes(page);
  const copy = nodes.find((n) => !ids.includes(n.id))!;
  const source = nodes.find((n) => n.id === ids[1])!;
  // Décalée d'environ 16 px écran (arrondi au pixel image) pour être visible.
  expect(Math.abs(copy.client.x - source.client.x - 16)).toBeLessThan(2);

  await page.keyboard.press('Control+c');
  await page.keyboard.press('Control+v');
  await expect.poll(async () => (await planNodes(page)).length).toBe(4);

  await page.keyboard.press('Delete');
  await expect.poll(async () => (await planNodes(page)).length).toBe(3);
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await planNodes(page)).length).toBe(4);
  const allIds = new Set((await planNodes(page)).map((n) => n.id));
  expect(allIds.size).toBe(4); // identifiants tous distincts
});

test('flèches clavier : 1 px image (Maj : 10), une seule action pour une rafale', async ({ page }) => {
  await page.keyboard.press('r');
  await dragOnCanvas(page, [300, 300], [450, 400]);
  await waitSaved(page);
  const x0 = (Object.values(await storedObjects(page))[0]!.geometry as Geo).x!;
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Shift+ArrowRight');
  await expect
    .poll(async () => (Object.values(await storedObjects(page))[0]!.geometry as Geo).x! - x0)
    .toBeCloseTo(15);
  await page.keyboard.press('Control+z');
  await expect
    .poll(async () => (Object.values(await storedObjects(page))[0]!.geometry as Geo).x)
    .toBeCloseTo(x0);
});

test('les annotations restent attachées au même pixel de la photo à 12,5 %, 25 %, 50 %, 100 %, 200 %, 400 % et après redimensionnement de la fenêtre', async ({
  page,
}) => {
  await page.keyboard.press('r');
  await dragOnCanvas(page, [300, 250], [420, 330]);
  await page.keyboard.press('p');
  for (const at of [
    [500, 200],
    [600, 230],
    [560, 320],
  ] as [number, number][])
    await clickOnCanvas(page, at);
  await page.keyboard.press('Enter');
  await waitSaved(page);
  const stored = await storedObjects(page);

  const check = async () => {
    const t = await settledTransform(page);
    for (const node of await planNodes(page)) {
      const g = stored[node.id]!.geometry as Geo;
      const xs = g.kind === 'rect' ? [g.x!, g.x! + g.width!] : g.points!.map((p) => p.x);
      const ys = g.kind === 'rect' ? [g.y!, g.y! + g.height!] : g.points!.map((p) => p.y);
      // Position écran attendue = coordonnées image × zoom + décalage (hors épaisseur du trait).
      const left = Math.min(...xs) * t.scale + t.x;
      const top = Math.min(...ys) * t.scale + t.y;
      const strokeHalf = ((stored[node.id]!.style as { strokeWidth: number }).strokeWidth / 2) * t.scale;
      expect(node.client.x).toBeCloseTo(left - strokeHalf, 0);
      expect(node.client.y).toBeCloseTo(top - strokeHalf, 0);
    }
    expect(await storedObjects(page)).toEqual(stored); // le zoom ne touche jamais aux données
  };

  await page.keyboard.press('1'); // 100 %
  await check();
  for (const key of ['+', '+', '+']) await page.keyboard.press(key); // ≈ 195 %
  await check();
  for (const key of ['+', '+', '+']) await page.keyboard.press(key); // ≈ 381 %
  await check();
  await page.keyboard.press('1');
  for (const key of ['-', '-', '-']) await page.keyboard.press(key); // ≈ 51 %
  await check();
  for (const key of ['-', '-', '-']) await page.keyboard.press(key); // ≈ 26 %
  await check();
  for (const key of ['-', '-', '-']) await page.keyboard.press(key); // ≈ 13 %
  await check();
  await page.setViewportSize({ width: 1100, height: 750 });
  await check();
});

test('rechargement immédiat après un geste : rien n’est perdu', async ({ page }) => {
  await page.keyboard.press('r');
  await dragOnCanvas(page, [300, 300], [450, 400]);
  await dragOnCanvas(page, [370, 350], [520, 420]);
  const [moved] = await planNodes(page);
  await page.reload(); // sans attendre la sauvegarde automatique
  await expect(page.getByTestId('navigation-controls')).toBeVisible();
  await expect.poll(async () => (await planNodes(page)).length).toBe(1);
  const [reopened] = await planNodes(page);
  expect(reopened!.x).toBeCloseTo(moved!.x, 6);
  expect(reopened!.y).toBeCloseTo(moved!.y, 6);
});

test('Espace + glisser sur un objet déplace la caméra, pas l’objet ; l’outil revient ensuite', async ({
  page,
}) => {
  await page.keyboard.press('r');
  await dragOnCanvas(page, [300, 300], [450, 400]);
  await page.waitForTimeout(100);
  const stored = await storedObjects(page);
  const t0 = await settledTransform(page);
  await page.keyboard.down('Space');
  await dragOnCanvas(page, [370, 350], [470, 400]);
  await page.keyboard.up('Space');
  const t1 = await settledTransform(page);
  expect(t1.x - t0.x).toBeCloseTo(100, 0);
  expect(await storedObjects(page)).toEqual(stored);
  await expect(page.getByTestId('canvas-container')).toHaveAttribute('data-tool', 'select');
});

test('le canevas ne vole jamais les touches d’un champ : R, Suppr et flèches restent dans le champ', async ({
  page,
}) => {
  await page.keyboard.press('r');
  await dragOnCanvas(page, [300, 300], [450, 400]);
  const name = page.getByLabel('Nom', { exact: true });
  await name.click();
  await name.press('End');
  await name.pressSequentially(' rue');
  await name.press('Backspace');
  await name.press('Delete');
  await name.press('ArrowLeft');
  await expect(name).toHaveValue('Zone personnalisée ru');
  await expect(page.getByTestId('canvas-container')).toHaveAttribute('data-tool', 'select');
  expect(await planNodes(page)).toHaveLength(1);
  // Toute la saisie du nom forme une seule action d'historique.
  await page.getByRole('button', { name: /Annuler \(Ctrl\+Z\)/ }).click();
  await expect(name).toHaveValue('Zone personnalisée');
});
