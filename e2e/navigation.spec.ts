import { expect, test } from '@playwright/test';
import {
  createCamp,
  createPlan,
  fixture,
  importBackground,
  openFreshApp,
  stageTransform,
  waitForBackground,
} from './helpers.ts';

test.beforeEach(async ({ page }) => {
  await openFreshApp(page);
  await createCamp(page, 'Camp test');
  await createPlan(page, 'Plan');
  await importBackground(page, fixture('quadrants.png'));
  await waitForBackground(page);
});

const imagePointAt = (t: { x: number; y: number; scale: number }, sx: number, sy: number) => ({
  x: (sx - t.x) / t.scale,
  y: (sy - t.y) / t.scale,
});

test('molette : le point sous le curseur reste sous le curseur', async ({ page }) => {
  const box = (await page.getByTestId('canvas-container').boundingBox())!;
  // Les événements molette portent des coordonnées entières : on vise un pixel entier.
  const cursor = { x: Math.round(box.width * 0.3), y: Math.round(box.height * 0.6) };
  await page.mouse.move(box.x + cursor.x, box.y + cursor.y);
  const before = imagePointAt(await stageTransform(page), cursor.x, cursor.y);
  for (const delta of [-100, -100, -100, 100, -100]) {
    await page.mouse.wheel(0, delta);
    await page.waitForTimeout(50);
  }
  const t = await stageTransform(page);
  const after = imagePointAt(t, cursor.x, cursor.y);
  expect(after.x).toBeCloseTo(before.x, 3);
  expect(after.y).toBeCloseTo(before.y, 3);
});

test('déplacement : outil main, bouton du milieu, Espace + glisser — le fond ne bouge jamais dans le projet', async ({
  page,
}) => {
  const box = (await page.getByTestId('canvas-container').boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  const t0 = await stageTransform(page);
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 120, cy + 40, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(50);
  const t1 = await stageTransform(page);
  expect(t1.x - t0.x).toBeCloseTo(120, 0);
  expect(t1.y - t0.y).toBeCloseTo(40, 0);

  await page.mouse.move(cx, cy);
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(cx - 60, cy - 30, { steps: 5 });
  await page.mouse.up({ button: 'middle' });
  await page.waitForTimeout(50);
  const t2 = await stageTransform(page);
  expect(t2.x - t1.x).toBeCloseTo(-60, 0);

  await page.keyboard.down('Space');
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 10, cy + 10, { steps: 3 });
  await page.mouse.up();
  await page.keyboard.up('Space');
  await page.waitForTimeout(50);
  expect((await stageTransform(page)).x - t2.x).toBeCloseTo(10, 0);

  // Le nœud de la photo reste en (0, 0), à sa taille d'origine, non déplaçable, non interactif.
  const node = await page.evaluate(() => {
    const K = (
      window as unknown as {
        Konva: {
          stages: {
            findOne(s: string): {
              x(): number;
              y(): number;
              width(): number;
              height(): number;
              rotation(): number;
              draggable(): boolean;
              isListening(): boolean;
            };
          }[];
        };
      }
    ).Konva;
    const image = K.stages[0]!.findOne('.background-image');
    return {
      x: image.x(),
      y: image.y(),
      w: image.width(),
      h: image.height(),
      r: image.rotation(),
      drag: image.draggable(),
      listen: image.isListening(),
    };
  });
  expect(node).toEqual({ x: 0, y: 0, w: 320, h: 200, r: 0, drag: false, listen: false });
});

test('boutons : + / − / adapter / 100 % / recentrer', async ({ page }) => {
  const level = page.getByTestId('zoom-level');
  const fitText = await level.textContent();
  await page.getByRole('button', { name: /Zoom avant/ }).click();
  expect(await level.textContent()).not.toBe(fitText);
  await page.getByRole('button', { name: /Zoom arrière/ }).click();
  await expect(level).toHaveText(fitText!);
  await page.getByRole('button', { name: /Taille réelle/ }).click();
  await expect(level).toHaveText('100 %');

  const box = (await page.getByTestId('canvas-container').boundingBox())!;
  await page.mouse.move(box.x + 100, box.y + 100);
  await page.mouse.down();
  await page.mouse.move(box.x + 400, box.y + 300, { steps: 4 });
  await page.mouse.up();
  await page.getByRole('button', { name: 'Recentrer' }).click();
  const t = await stageTransform(page);
  expect(t.scale).toBe(1);
  expect(t.x + 160).toBeCloseTo(box.width / 2, 0);
  expect(t.y + 100).toBeCloseTo(box.height / 2, 0);

  await page.getByRole('button', { name: /Adapter à l’écran/ }).click();
  await expect(level).toHaveText(fitText!);
});

test('le dernier zoom est mémorisé comme préférence d’affichage', async ({ page }) => {
  await page.getByRole('button', { name: /Taille réelle/ }).click();
  await page.waitForTimeout(1200);
  await page.reload();
  await expect(page.getByTestId('zoom-level')).toHaveText('100 %');
});
