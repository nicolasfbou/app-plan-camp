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

## Phase 2 — Outils de dessin et édition ✅

- Outils : Sélection, Main, Rectangle, Rectangle arrondi, Ellipse / cercle, Polygone, Ligne,
  Polyligne, Texte, Étiquette ; retour automatique à Sélection après création
- Modèles de zones (15) et de bâtiments (10) appliqués à la création (type, nom, style, calque)
- Sélection, déplacement, redimensionnement, rotation (Transformer, échelle intégrée à la géométrie)
- Modification des sommets des polygones et polylignes ; édition de texte en place (double clic)
- Panneau de propriétés adapté au type ; couleurs rapides + personnalisée ; opacité 0-100 % ;
  styles de ligne continu / tirets / pointillé
- Calques : afficher / masquer, verrouiller, liste des objets ; ordre dans le calque
- Copier / coller (presse-papiers interne), dupliquer, supprimer, flèches clavier (1 / 10 px image)
- Annuler / rétablir branchés sur toutes les opérations ; journal de récupération à la fermeture

## Phase 3 — Fichier `.campplan`, calques avancés, sélection multiple, sommets ✅

- Export / import `.campplan` : photo et PDF d'origine, plan complet, modèles utilisés, métadonnées,
  calibration, SHA-256, version du format ; vérification complète avant écriture ; copie par
  défaut, remplacement seulement confirmé (voir ARCHITECTURE §14.1)
- Schéma v2 (`groupId`) avec migration depuis v1
- Calques : créer, renommer, dupliquer, réordonner (le rendu suit), afficher seulement, calque actif
- Sélection multiple (Maj + clic, rectangle, Ctrl+A), groupes, opérations groupées en une action
- Sommets : insérer, supprimer ; fermer une polyligne ; rectangle → polygone
- Essai complet sur la photo réelle du Camp 105 (`bench/camp105-phase3.mjs`)

## Phase 4 — Circulation et zones opérationnelles ✅

- Trajets de véhicules : 7 catégories, sens / inverse / double sens, flèches calculées le long du
  tracé (jamais hors du chemin), sommets modifiables ; voies d'urgence tracées comme les trajets
- Corridors piétons : largeur (px image), bords calculés dans les virages, pictogrammes droits ou
  orientés
- Zones : stationnement (7), livraison et débarquement (8), sécurité et accès (8), pictogramme et
  nom au centre, bordure de délimitation rouge / orange, hachures
- Bibliothèque de 30 pictogrammes en 7 catégories ; import PNG / SVG vérifié
- Analyse des croisements piétons / véhicules (aide à la planification, pas une certification)
- Affichage par catégorie ; limites d'affichage des repères ; schéma v3 ; `.campplan` format 2
- Démonstration sur la photo réelle du Camp 105 (`bench/camp105-phase4.mjs`)

## Phase 5 — Plan professionnel et export PDF ✅

- Calibration (2 clics + distance réelle), mesures approximatives honnêtes (m / m², pi / pi², px
  sans calibration), cotes ; corridors en mètres
- Générateur de cases de stationnement (jamais hors du contour, cases modifiables une à une)
- Légende automatique, cartouche (statut « Approuvé » explicite et confirmé), nord manuel, barre
  d'échelle seulement si calibré
- Export PDF vectoriel (Lettre, Légal, Tabloïd, A4, A3, A2, A1 ; portrait / paysage ; complet,
  simplifié, sans fond), PNG / JPG, aperçu fidèle avec avertissements ; schéma v4
- Démonstration sur la photo réelle du Camp 105 (`bench/camp105-phase5.mjs`)

## Phase 6 — Utilisation quotidienne et lisibilité ✅

- Vues par public (Employés, Fournisseurs, Direction, Sécurité / urgence, personnalisée) : filtre et
  réglages d'impression propres, sans jamais modifier le plan ; éléments exclus par vue
- Styles d'impression : Terrain, Présentation client, Fournisseur, Employés, Noir et blanc
- Lisibilité dans l'éditeur (même moteur que le PDF) ; placement proposé des étiquettes, accepté ou
  refusé, avec ligne de renvoi
- Modèles d'entreprise `.campmodele` ; plan créé depuis un modèle ; styles d'entreprise
- Export groupé (PDF par public, .zip ou PDF multi-pages) ; variantes été / hiver ; schéma v5
- Démonstration sur la photo réelle du Camp 105 (`bench/camp105-phase6.mjs`)

## Phase 7 — Révisions, historique et comparaison ✅

- Révisions figées A, B, C… : instantané complet et structuré (objets, calques, vues, impression,
  légende, cartouche), photo référencée par son SHA-256 (jamais dupliquée), empreinte vérifiée à
  chaque lecture, sceau des champs figés et de l'approbation
- Statuts Brouillon, En révision, À valider sur le terrain, Approuvé, Archivé ; approbation
  explicite (approbateur, date, commentaire, auteur de la révision) ; révision approuvée non
  modifiable (archivage seulement) et non supprimable ; journal des statuts
- Historique des révisions, consultation en lecture seule (vues telles qu'au moment de la révision),
  PDF de révision (cartouche : révision, date, auteur, statut, approuvé par ; tableau des révisions)
- Comparaison révision ↔ révision ou ↔ brouillon : superposition et avant / après ; rapport de
  changements (PDF, Markdown) distinguant changements de l'utilisateur et automatiques
- Nouveau brouillon à partir d'une révision (remplacement annulable ou plan séparé) ; suppressions
  protégées ; schéma v6 ; `.campplan` format 3 avec révisions
- Démonstration sur la photo réelle du Camp 105 (`bench/camp105-phase7.mjs`) ; mesures de
  performance (`revisions.perf.test.ts`, `bench/revisions-browser-perf.mjs`)

## Phase 8 — Fiabilité, portabilité et exploitation terrain ✅

- Copies externes `.campplan` horodatées (dossier choisi, File System Access API ; repli par
  rappel + téléchargement) : toutes les 15 min, à la fermeture, après révision / approbation ;
  rotation modifiable (10 / 7 / 4, approuvées conservées)
- Santé du projet (vert / jaune / rouge), réparations contrôlées, nettoyage avec espace annoncé,
  journal local des erreurs, diagnostic exportable (sans photo, contenu ni noms)
- Verrou d'édition entre onglets (lecture seule, reprise de la main sans perte), versions et
  conflits affichés, récupération après plantage (journal à version contrôlée)
- Import sûr avec mode récupération partielle ; copie de secours d'urgence (même plan illisible)
- Tests de plantage réel (processus tué), multi-onglets, portabilité, performances 50 MP
- Frontières d'un futur serveur documentées (`docs/SERVER-BOUNDARIES.md`)

## Phase 9 — À définir

Collaboration, serveur, comptes et permissions, synchronisation, commentaires partagés : non
développés (demande explicite), à planifier.

## V2

Objets partagés entre plans (été / hiver), rendu par tuiles des très grandes images (au-delà des limites du
navigateur), polices italiques dans le PDF, collaboration et serveur.
