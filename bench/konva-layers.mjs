/**
 * Banc d'essai : coût mémoire et fluidité de N couches Konva physiques.
 * Option A : 8 Konva.Layer (une par catégorie).
 * Option B : 3 Konva.Layer (fond / contenu avec 6 groupes logiques / surcouche).
 *
 * Usage : node bench/konva-layers.mjs <image> [chromiumPath]
 * Mesure la mémoire résidente totale des processus Chromium (ps) et le temps moyen par image
 * pendant un déplacement continu. Chaque configuration tourne dans un navigateur neuf.
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const imagePath = process.argv[2];
const executablePath = process.argv[3] ?? process.env.PW_CHROMIUM_PATH;
if (!imagePath) throw new Error('Usage : node bench/konva-layers.mjs <image> [chromium]');
const konvaSource = readFileSync(new URL('../node_modules/konva/konva.min.js', import.meta.url), 'utf8');
const imageBytes = readFileSync(imagePath);

function chromiumRssMb() {
  const out = execSync("ps -eo rss,comm | grep -Ei 'chrome|headless_shell' || true").toString();
  return out
    .trim()
    .split('\n')
    .filter(Boolean)
    .reduce((sum, line) => sum + Number(line.trim().split(/\s+/)[0]) / 1024, 0);
}

async function run({ physicalLayers, deviceScaleFactor, withImage }) {
  const browser = await chromium.launch(executablePath ? { executablePath } : {});
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor });
  await page.route('http://bench.local/photo', (route) =>
    route.fulfill({ body: imageBytes, contentType: 'image/jpeg' }),
  );
  await page.route('http://bench.local/', (route) =>
    route.fulfill({
      body: '<html><body style="margin:0"><div id="c"></div></body></html>',
      contentType: 'text/html',
    }),
  );
  await page.goto('http://bench.local/');
  await page.addScriptTag({ content: konvaSource });
  const baseline = chromiumRssMb();

  const result = await page.evaluate(
    async ({ physicalLayers, withImage }) => {
      const K = window.Konva;
      const stage = new K.Stage({ container: 'c', width: 1920, height: 1080 });
      const categories = ['zones', 'buildings', 'circulation', 'pedestrians', 'signage', 'texts'];
      const background = new K.Layer({ listening: false });
      stage.add(background);
      let bitmap = null;
      if (withImage) {
        const blob = await (await fetch('http://bench.local/photo')).blob();
        bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
        background.add(
          new K.Image({ image: bitmap, x: 0, y: 0, width: bitmap.width, height: bitmap.height }),
        );
      }
      const targets = [];
      if (physicalLayers === 8) {
        for (const _ of categories) {
          const layer = new K.Layer();
          stage.add(layer);
          targets.push(layer);
        }
      } else {
        const content = new K.Layer();
        stage.add(content);
        for (const name of categories) {
          const group = new K.Group({ name });
          content.add(group);
          targets.push(group);
        }
      }
      stage.add(new K.Layer()); // surcouche sélection / UI
      // 300 objets répartis dans les catégories (ordre de grandeur d'un vrai plan).
      for (let i = 0; i < 300; i++) {
        targets[i % targets.length].add(
          new K.Rect({
            x: (i % 20) * 240,
            y: Math.floor(i / 20) * 240,
            width: 180,
            height: 120,
            fill: 'rgba(37,99,235,0.3)',
            stroke: '#1d4ed8',
            strokeWidth: 3,
          }),
        );
      }
      stage.scale({ x: 0.25, y: 0.25 });
      stage.draw();
      await new Promise((r) => setTimeout(r, 500));

      // Déplacement continu : 120 images, comme un pan à la souris.
      const frames = [];
      await new Promise((resolve) => {
        let i = 0;
        let last = performance.now();
        const step = () => {
          const now = performance.now();
          if (i > 0) frames.push(now - last);
          last = now;
          if (i++ >= 120) return resolve();
          stage.position({ x: -i * 8, y: -i * 4 });
          stage.batchDraw();
          requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      });
      frames.sort((a, b) => a - b);
      const canvases = [...document.querySelectorAll('canvas')].length;
      return {
        canvases,
        avgFrameMs: frames.reduce((a, b) => a + b, 0) / frames.length,
        p95FrameMs: frames[Math.floor(frames.length * 0.95)],
      };
    },
    { physicalLayers, withImage },
  );
  await page.waitForTimeout(500);
  const rss = chromiumRssMb();
  await browser.close();
  return { ...result, rssMb: Math.round(rss), deltaMb: Math.round(rss - baseline) };
}

const rows = [];
for (const deviceScaleFactor of [1, 2]) {
  for (const physicalLayers of [8, 3]) {
    const samples = [];
    for (let i = 0; i < 3; i++)
      samples.push(await run({ physicalLayers, deviceScaleFactor, withImage: true }));
    const median = (key) => samples.map((s) => s[key]).sort((a, b) => a - b)[1];
    rows.push({
      écran: `1920×1080 @${deviceScaleFactor}x`,
      couchesPhysiques: physicalLayers,
      canvasDOM: samples[0].canvases,
      'RAM Chromium (Mo)': median('rssMb'),
      'image moy. (ms)': median('avgFrameMs').toFixed(1),
      'image p95 (ms)': median('p95FrameMs').toFixed(1),
    });
  }
}
console.table(rows);
