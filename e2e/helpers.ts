import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { type Page, expect } from '@playwright/test';

export const fixture = (name: string) => new URL(`./fixtures/${name}`, import.meta.url).pathname;
export const sha256OfFile = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
export const sha256OfBuffer = (buffer: Buffer) => createHash('sha256').update(buffer).digest('hex');

export async function createCamp(page: Page, name: string) {
  await page.getByRole('button', { name: 'Nouveau camp' }).click();
  await page.getByLabel('Nom du camp').fill(name);
  await page.getByRole('button', { name: 'Créer' }).click();
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
}

export async function createPlan(page: Page, name: string) {
  await page.getByRole('button', { name: 'Nouveau plan' }).click();
  await page.getByLabel('Nom du plan').fill(name);
  await page.getByRole('button', { name: 'Créer' }).click();
  await expect(page.getByTestId('plan-title')).toHaveText(name);
}

export async function importBackground(page: Page, file: string) {
  await page.getByTestId('import-input').setInputFiles(file);
}

export async function waitForBackground(page: Page) {
  await expect(page.getByTestId('navigation-controls')).toBeVisible({ timeout: 30_000 });
}

export async function waitSaved(page: Page) {
  await expect(page.getByTestId('save-status')).toHaveText('Enregistré', { timeout: 10_000 });
}

/** Transformation réelle du Stage Konva (lue sur l'objet Konva exposé globalement). */
export async function stageTransform(page: Page) {
  return page.evaluate(() => {
    const stage = (
      window as unknown as { Konva: { stages: { x(): number; y(): number; scaleX(): number }[] } }
    ).Konva.stages[0]!;
    return { x: stage.x(), y: stage.y(), scale: stage.scaleX() };
  });
}

/** Pixels RGBA du canevas du fond (couche physique « background »), en pixels écran CSS. */
export async function backgroundPixels(page: Page, x: number, y: number, width: number, height: number) {
  return page.evaluate(
    async ({ x, y, width, height }) => {
      // Konva redessine à l'image d'animation suivante : on attend que le rendu soit à jour.
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const canvas = document.querySelector('[data-testid="canvas-container"] canvas') as HTMLCanvasElement;
      const ratio = canvas.width / canvas.clientWidth;
      const data = canvas
        .getContext('2d')!
        .getImageData(x * ratio, y * ratio, width * ratio, height * ratio).data;
      return Array.from(data);
    },
    { x, y, width, height },
  );
}

export async function openFreshApp(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  return errors;
}

/** Attend que la transformation du Stage soit stable (rendu par image d'animation). */
export async function settledTransform(page: Page) {
  let previous = '';
  let current = await stageTransform(page);
  await expect
    .poll(async () => {
      previous = JSON.stringify(current);
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      current = await stageTransform(page);
      return JSON.stringify(current) === previous;
    })
    .toBe(true);
  return current;
}

// --- Phase 2 : dessin et lecture de l'état réel -------------------------------------------------

export async function canvasBox(page: Page) {
  return (await page.getByTestId('canvas-container').boundingBox())!;
}

/** Cliquer-glisser en coordonnées locales à la zone de travail. */
export async function dragOnCanvas(page: Page, from: [number, number], to: [number, number], steps = 6) {
  const box = await canvasBox(page);
  await page.mouse.move(box.x + from[0], box.y + from[1]);
  await page.mouse.down();
  await page.mouse.move(box.x + to[0], box.y + to[1], { steps });
  await page.mouse.up();
}

export async function clickOnCanvas(page: Page, at: [number, number]) {
  const box = await canvasBox(page);
  await page.mouse.click(box.x + at[0], box.y + at[1]);
}

export interface NodeInfo {
  id: string;
  className: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
  /** Boîte à l'écran, en pixels locaux à la zone de travail. */
  client: { x: number; y: number; width: number; height: number };
}

/** Nœuds Konva des objets du plan (état réellement affiché). */
export async function planNodes(page: Page): Promise<NodeInfo[]> {
  return page.evaluate(() => {
    type N = {
      id(): string;
      getClassName(): string;
      x(): number;
      y(): number;
      width(): number;
      height(): number;
      rotation(): number;
      scaleX(): number;
      scaleY(): number;
      getClientRect(): { x: number; y: number; width: number; height: number };
    };
    const K = (window as unknown as { Konva: { stages: { find(s: string): N[] }[] } }).Konva;
    return K.stages[0]!.find('.plan-object').map((n) => ({
      id: n.id(),
      className: n.getClassName(),
      x: n.x(),
      y: n.y(),
      width: n.width(),
      height: n.height(),
      rotation: n.rotation(),
      scaleX: n.scaleX(),
      scaleY: n.scaleY(),
      client: n.getClientRect(),
    }));
  });
}

/** Objets tels qu'ENREGISTRÉS dans IndexedDB (document du premier plan trouvé). */
export async function storedObjects(page: Page): Promise<Record<string, Record<string, unknown>>> {
  return page.evaluate(
    () =>
      new Promise((resolve) => {
        const open = indexedDB.open('campplanner');
        open.onsuccess = () => {
          const request = open.result.transaction('plans').objectStore('plans').getAll();
          request.onsuccess = () => {
            const record = request.result[0] as
              { document: { objects: Record<string, Record<string, unknown>> } } | undefined;
            resolve(record?.document.objects ?? {});
            open.result.close();
          };
        };
      }),
  );
}

export async function openPlanWithPhoto(page: Page, file = fixture('quadrants.png')) {
  await openFreshApp(page);
  await createCamp(page, 'Camp test');
  await createPlan(page, 'Plan');
  await importBackground(page, file);
  await waitForBackground(page);
}
