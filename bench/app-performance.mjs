/**
 * Mesure de performance de l'application réelle avec une vraie photo (parcours utilisateur).
 * Prérequis : `npm run build && npx vite preview --port 4177`.
 * Usage : node bench/app-performance.mjs <image> [dossier-captures]
 *
 * Mesure : temps d'import, temps de réouverture, mémoire totale de Chromium, fluidité du
 * déplacement (intervalle entre images) à plusieurs niveaux de zoom, et captures d'écran.
 * Attention : Chromium sans GPU (rendu logiciel). Mesures de référence de cet environnement, pas une
 * garantie : sur un poste réel, elles dépendent du GPU, du navigateur et de la résolution d'écran.
 */
import { execSync } from 'node:child_process';
import { chromium } from '@playwright/test';

const [imagePath, shotsDir] = process.argv.slice(2);
const executablePath = process.env.PW_CHROMIUM_PATH;
const URL_APP = process.env.APP_URL ?? 'http://localhost:4177/';

const rssMb = () =>
  Math.round(
    execSync("ps -eo rss,comm | grep -Ei 'chrome|headless_shell' || true")
      .toString()
      .trim()
      .split('\n')
      .filter(Boolean)
      .reduce((sum, line) => sum + Number(line.trim().split(/\s+/)[0]) / 1024, 0),
  );

const browser = await chromium.launch(executablePath ? { executablePath } : {});
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const baseline = rssMb();
await page.goto(URL_APP);
await page.getByRole('button', { name: 'Nouveau camp' }).click();
await page.getByLabel('Nom du camp').fill('Camp mesure');
await page.getByRole('button', { name: 'Créer' }).click();
await page.getByRole('button', { name: 'Nouveau plan' }).click();
await page.getByRole('button', { name: 'Créer' }).click();

let t = Date.now();
await page.getByTestId('import-input').setInputFiles(imagePath);
const warning = page.getByRole('button', { name: 'Ouvrir quand même' });
await Promise.race([
  page.getByTestId('navigation-controls').waitFor({ timeout: 120_000 }),
  warning.waitFor({ timeout: 120_000 }).then(() => warning.click()),
]);
await page.getByTestId('navigation-controls').waitFor({ timeout: 120_000 });
const importMs = Date.now() - t;
await page.getByTestId('save-status').filter({ hasText: 'Enregistré' }).waitFor({ timeout: 30_000 });
const dims = await page.getByTestId('bg-dimensions').textContent();

t = Date.now();
await page.reload();
await page.getByTestId('navigation-controls').waitFor({ timeout: 120_000 });
const reopenMs = Date.now() - t;
await page.keyboard.press('0');
await page.waitForTimeout(1500);
const rssAfterOpen = rssMb();

async function measurePan() {
  const box = await page.getByTestId('canvas-container').boundingBox();
  await page.evaluate(() => {
    window.__frames = [];
    let last = performance.now();
    window.__stop = false;
    const loop = (now) => {
      window.__frames.push(now - last);
      last = now;
      if (!window.__stop) requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  for (let i = 1; i <= 60; i++) await page.mouse.move(cx + Math.sin(i / 6) * 200, cy + Math.cos(i / 6) * 120);
  await page.mouse.up();
  const frames = await page.evaluate(() => {
    window.__stop = true;
    return window.__frames.slice(2);
  });
  frames.sort((a, b) => a - b);
  const avg = frames.reduce((a, b) => a + b, 0) / frames.length;
  return { avg, p95: frames[Math.floor(frames.length * 0.95)], fps: 1000 / avg };
}

const levels = [
  ['Adapter', ['0']],
  ['≈ 25 %', ['1', '-', '-', '-', '-', '-', '-']],
  ['≈ 50 %', ['1', '-', '-', '-']],
  ['100 %', ['1']],
  ['≈ 200 %', ['1', '+', '+', '+']],
  ['≈ 400 %', ['1', '+', '+', '+', '+', '+', '+']],
];
const rows = [];
for (const [label, keys] of levels) {
  for (const key of keys) await page.keyboard.press(key);
  await page.waitForTimeout(300);
  const zoom = await page.getByTestId('zoom-level').textContent();
  if (shotsDir) {
    await page
      .getByTestId('canvas-container')
      .screenshot({ path: `${shotsDir}/zoom-${label.replace(/[^0-9a-z]/gi, '') || 'fit'}.png` });
  }
  const pan = await measurePan();
  rows.push({
    niveau: label,
    zoom,
    'image moy. (ms)': pan.avg.toFixed(1),
    'p95 (ms)': pan.p95.toFixed(1),
    'ips moy.': pan.fps.toFixed(0),
  });
}
const rssEnd = rssMb();
await browser.close();

console.log(`Image : ${imagePath} (${dims})`);
console.log(`Import : ${importMs} ms · Réouverture après rechargement : ${reopenMs} ms`);
console.log(
  `RAM Chromium : repos ${baseline} Mo → plan ouvert ${rssAfterOpen} Mo → après navigation ${rssEnd} Mo`,
);
console.table(rows);
