import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

export default defineConfig({
  // Version affichée dans le rapport de diagnostic.
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  build: {
    // Application installée et mise en cache hors ligne : le bundle principal (~315 Ko gzip,
    // dominé par Konva, React et zod) est téléchargé une seule fois. pdf.js, jsPDF, les polices et
    // le moteur d'export sont séparés et chargés à la demande. Le seuil signale une croissance
    // anormale au-delà de 1,1 Mo.
    chunkSizeWarningLimit: 1100,
  },
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'prompt',
      includeAssets: ['favicon.svg'],
      manifest: {
        name: 'CampPlanner',
        short_name: 'CampPlanner',
        description: 'Plans de campements industriels sur photo aérienne originale.',
        lang: 'fr',
        start_url: '/',
        display: 'standalone',
        background_color: '#0f172a',
        theme_color: '#0f172a',
        icons: [
          { src: 'pwa-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'pwa-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,mjs,css,html,svg,png,woff2,ttf}'],
        // Konva + React dépassent la limite par défaut (2 Mo) une fois regroupés.
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
      },
    }),
  ],
});
