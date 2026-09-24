/** Outils communs des tests de bout en bout avec le serveur CampPlanner (phase 9 et suivantes). */
import { type Browser, type Page, expect } from '@playwright/test';
import {
  clickOnCanvas,
  createCamp,
  createPlan,
  fixture,
  importBackground,
  waitForBackground,
  waitSaved,
} from './helpers.ts';

export const PASSWORD = 'mot-de-passe-solide-2026';
export const SERVER = 'http://localhost:8787';
export const unique = (name: string) => `${name} ${Math.random().toString(36).slice(2, 7)}`;

export async function login(page: Page, email: string, mode: 'trusted' | 'shared' = 'trusted') {
  await page.goto('/#/connexion');
  await page.getByLabel('Courriel').fill(email);
  await page.getByLabel('Mot de passe').fill(PASSWORD);
  await page
    .getByTestId('device-mode')
    .getByRole('radio')
    .nth(mode === 'trusted' ? 0 : 1)
    .check();
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('workspace-bar')).toBeVisible();
  await expect(page.getByTestId('workspace-select')).toContainText('PAMM');
}

export async function newContext(browser: Browser) {
  return browser.newContext({ baseURL: SERVER, viewport: { width: 1600, height: 1000 } });
}

export async function label(page: Page, at: [number, number], text: string) {
  await page.keyboard.press('g');
  await clickOnCanvas(page, at);
  await page.getByTestId('text-editor').fill(text);
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
}

export const indicator = (page: Page) => page.getByTestId('sync-indicator').first();

/**
 * Point de synchronisation déterministe : état « synchronisé », AUCUN cycle en cours (aucune
 * requête en vol) et file vide. Jamais une simple attente de durée.
 */
export async function expectSynced(page: Page, timeout = 30_000) {
  await expect(indicator(page)).toHaveAttribute('data-state', 'synced', { timeout });
  await expect(indicator(page)).toHaveAttribute('data-syncing', 'false', { timeout });
  await expect(indicator(page)).toHaveAttribute('data-pending', '0', { timeout });
}

export async function campWithPhoto(page: Page, camp: string) {
  await createCamp(page, camp);
  await createPlan(page, 'Circulation');
  await importBackground(page, fixture('quadrants.png'));
  await waitForBackground(page);
  await waitSaved(page);
  await expectSynced(page);
  return page.url();
}

export const planIdOf = (url: string) => url.split('/plan/')[1]!;

/** Bases IndexedDB d'espaces d'organisation présentes dans ce navigateur. */
export const orgDatabases = (page: Page) =>
  page.evaluate(async () =>
    (await indexedDB.databases())
      .map((d) => d.name ?? '')
      .filter((n) => n.startsWith('campplanner-') && n !== 'campplanner'),
  );
