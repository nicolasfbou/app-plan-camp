import { mergeConfig, defineConfig } from 'vitest/config';
import viteConfig from './vite.config.ts';

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      projects: [
        {
          extends: true,
          test: {
            name: 'client',
            environment: 'jsdom',
            setupFiles: ['./src/test/setup.ts'],
            include: ['src/**/*.test.{ts,tsx}'],
          },
        },
        {
          // Serveur : Node + PostgreSQL réel (instance temporaire, voir server/test/globalSetup.ts).
          extends: true,
          test: {
            name: 'server',
            environment: 'node',
            include: ['server/**/*.test.ts'],
            globalSetup: ['./server/test/globalSetup.ts'],
            testTimeout: 30_000,
            hookTimeout: 60_000,
          },
        },
      ],
    },
  }),
);
