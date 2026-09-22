# Feuille de route

Règle : le parcours complet doit être fiable avant toute fonction avancée.

> Nouveau camp → nouveau plan → importer photo → zoomer → se déplacer → dessiner une zone →
> dessiner une route → ajouter des flèches → ajouter un corridor piéton → ajouter du texte →
> gérer les calques → sauvegarder → fermer → rouvrir → retrouver exactement le même plan → exporter.

## Phase 0 — Fondations ✅

- React 19, TypeScript strict, Vite, PWA installable et hors ligne (mise à jour sur demande, jamais forcée)
- Konva : Stage organisé en 8 couches (fond, zones, bâtiments, circulation, piétons, signalisation, textes, surcouche)
- Modèle de données versionné (`schemaVersion: 1`) validé par zod ; migrations en chaîne
- Viewport pur `projet → écran` (zoom autour du curseur, pan, adapter, 100 %) séparé des données
- Transformation d'export indépendante de l'écran (résolution native ou supérieure)
- Store Zustand + Immer : annuler/rétablir (200 actions), transactions pour les interactions continues
- Dépôt IndexedDB (Dexie) : camps, plans, fichiers d'origine avec empreinte SHA-256
- Sauvegarde automatique à la fin des interactions, jamais pendant un glisser
- Zones prédéfinies en configuration ; i18n (français)
- Mise en page desktop : sidebar foncée, zone de travail maximale, panneau droit, panneaux réductibles
- Tests unitaires (Vitest) + navigateur (Playwright) ; lint, format, typecheck, build en CI

## Phase 1 — Plan de base ✅

- Camps : créer, lister, renommer, supprimer (confirmation). Plans : créer (avec type), ouvrir,
  renommer, dupliquer (photo partagée), supprimer (confirmation)
- Import JPG / JPEG / PNG / WEBP : format réel, dimensions et orientation lues sans décodage, SHA-256,
  original conservé à l'octet près ; import PDF avec choix de page et de résolution
- Seuils normal / grande / potentiellement dangereuse, avec message détaillé avant décodage
- Fond verrouillé ; vérification d'intégrité à chaque ouverture ; panneau « Fond » en lecture seule ;
  téléchargement de l'original
- Navigation : molette autour du curseur, trackpad (pincement et défilement), bouton du milieu,
  Espace + glisser, outil main, écran tactile ; + / − / adapter / 100 % / recentrer ; raccourcis
- Sauvegarde automatique branchée ; reprise par l'URL après rechargement ou plantage ;
  préférence de vue séparée du projet
- Rendu Konva : 3 couches physiques, 8 catégories logiques (mesure et décision : ARCHITECTURE §11)

## Phase 2 — Dessin de base

Sélection, rectangle, polygone, ellipse, ligne, polyligne, texte, étiquette ; déplacer, redimensionner,
pivoter ; panneau Propriétés ; zones prédéfinies.

## Phase 3 — Calques et raccourcis

Afficher/masquer, verrouiller, renommer, réordonner, opacité, « seulement ce calque » ;
copier/coller/dupliquer/supprimer, flèches clavier.

## Phase 4 — Fichier `.campplan`

Export et import complets (image d'origine, annotations, calques, styles, calibration, métadonnées).

## Phase 5 — Circulation et piétons

Flux fléchés (sens, double sens, taille, fréquence), presets de circulation, corridor piéton
(largeur, remplissages, icônes), icônes et signalisation.

## Phase 6 — Export

PNG / JPG haute résolution, PDF Lettre / Légal / 11x17 / A4 / A3, portrait / paysage, marges, titre.

## V2

Calibration et mesures, légende automatique, cartouche, Nord et échelle, générateur de stationnement,
modèles réutilisables, mode hiver, PDF vectoriel, tuilage des très grandes images.
