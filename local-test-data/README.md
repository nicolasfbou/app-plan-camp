# Données de test locales

Déposez ici la photo aérienne réelle du camp (JPG, PNG, WEBP ou PDF). Ce dossier est exclu de git :
les fichiers qu'il contient ne sont jamais poussés sur le dépôt. La photo n'est jamais modifiée :
l'application et les scripts ne font que la lire.

Test visuel d'attache des annotations (après `npm run build && npx vite preview --port 4178`) :

```bash
node bench/real-photo-check.mjs local-test-data/<photo> local-test-data/annotations.json local-test-data/captures
```

`annotations.json` (coordonnées en pixels de la photo, lisibles dans n'importe quel visualiseur) :

```json
[
  { "tool": "rect", "preset": "building.dormitory", "points": [[1200, 800], [1650, 980]] },
  { "tool": "polygon", "preset": "zone.parking", "points": [[300, 400], [700, 420], [680, 700], [320, 680]] },
  { "tool": "line", "points": [[100, 1500], [2000, 1400]] },
  { "tool": "label", "at": [1425, 760], "text": "DORTOIR 1" }
]
```
