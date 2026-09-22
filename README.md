# CampPlanner

Éditeur de plans de campements industriels : on importe une photo aérienne (drone, satellite, PDF)
et on dessine par-dessus des zones, la circulation, les corridors piétons, la signalisation et des textes.

**Principe fondamental : photo originale intacte + calques éditables au-dessus.**

- Architecture et décisions : [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- État d'avancement : [`docs/ROADMAP.md`](docs/ROADMAP.md)

## Développement

Prérequis : Node 22.

```bash
npm install
npm run dev          # serveur de développement
npm run check        # typecheck + lint + format + tests + build
npm run test:e2e     # tests navigateur (Playwright)
```

Dans un environnement où Chromium est déjà installé, on peut l'indiquer à Playwright :
`PW_CHROMIUM_PATH=/chemin/vers/chrome npm run test:e2e`.

## Structure

```
src/
  domain/        logique pure (sans React ni Konva), testée unitairement
    model/       schéma versionné (zod), types, fabriques, opérations
    viewport/    transformation projet → écran (zoom, pan, adapter)
    schema/      sérialisation, validation, migrations de schemaVersion
    presets/     zones prédéfinies (données, extensibles)
    export/      transformation d'export indépendante de l'écran
    image/       empreinte SHA-256 des fichiers d'origine
  store/         Zustand : plan + historique (Immer), viewport, interface
  persistence/   dépôt IndexedDB (Dexie), sauvegarde automatique
  editor/        Stage Konva et couches de rendu
  app/           coquille de l'application (barres, panneaux, raccourcis)
  ui/            composants d'interface génériques
  i18n/          textes de l'interface (français ; anglais prévu)
e2e/             tests Playwright
```
