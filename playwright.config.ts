import { defineConfig, devices } from '@playwright/test';

// En local (conteneur), un Chromium préinstallé peut être imposé via PW_CHROMIUM_PATH.
const executablePath = process.env.PW_CHROMIUM_PATH;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://localhost:4173',
    viewport: { width: 1600, height: 1000 },
  },
  projects: [
    {
      // Phases 1 à 8 : application seule (aucun serveur), comme sur une clé USB ou hors ligne.
      name: 'chromium',
      testIgnore: /phase9\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], ...(executablePath ? { launchOptions: { executablePath } } : {}) },
    },
    {
      // Phase 9 : application servie par le serveur CampPlanner (PostgreSQL temporaire).
      name: 'serveur',
      testMatch: /phase9\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        baseURL: 'http://localhost:8787',
        viewport: { width: 1600, height: 1000 },
        ...(executablePath ? { launchOptions: { executablePath } } : {}),
      },
    },
  ],
  webServer: [
    {
      command: 'npm run build && npm run preview -- --port 4173 --strictPort',
      url: 'http://localhost:4173',
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
    },
    {
      // Sert `dist/` (construit par la commande précédente, prête avant le début des tests).
      command: 'PORT=8787 npx tsx --tsconfig server/tsconfig.json server/scripts/e2e-server.ts',
      url: 'http://localhost:8787/api/health',
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
    },
  ],
});
