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
