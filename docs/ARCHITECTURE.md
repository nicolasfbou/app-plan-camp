# CampPlanner — Audit technique et proposition d'architecture

> Statut : **architecture approuvée**. Phases 0 et 1 livrées, voir [`ROADMAP.md`](ROADMAP.md).
>
> Principe directeur : **PHOTO ORIGINALE INTACTE + CALQUES ÉDITABLES AU-DESSUS.**

---

## 0. Décisions validées (elles priment sur le reste du document)

| Sujet             | Décision                                                                                                                                                                                                                                      |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Plateforme        | Application web, installable en PWA sous Windows, utilisable hors ligne. Desktop prioritaire. Pas d'application native pour l'instant ; architecture compatible avec un emballage Tauri plus tard (aucune dépendance à un serveur).           |
| Données V1        | Local, sans compte ni serveur. Obligatoire : autosave IndexedDB, récupération après crash, export et import `.campplan` complets, duplication de projet, indicateur « non enregistré », format versionné. Ne pas dépendre du seul navigateur. |
| Taille des images | Confortable pour 20 à 50 MP. Dimensions détectées à l'import ; au-delà d'une limite sûre, avertissement clair plutôt qu'un plantage. Tuilage possible plus tard (non bloqué par l'architecture).                                              |
| Image originale   | Octets d'origine conservés. Orientation EXIF appliquée à l'affichage seulement, sans réencodage. Coordonnées des annotations = image affichée. Aucun filtre, sharpen, IA, recadrage, upscale.                                                 |
| Langue            | Interface en français, textes centralisés dans `src/i18n` pour ajouter l'anglais sans refonte.                                                                                                                                                |
| Design            | Professionnel, industriel, lisible : sidebar foncée, grande zone de travail, panneaux clairs, accent bleu, peu de décorations. La maquette est une direction, pas une contrainte.                                                             |
| Écran             | Gauche : outils. Centre : plan (maximum d'espace). Droite : propriétés et calques. Haut : nom, annuler/rétablir, sauvegarde, import/export. Panneaux latéraux réductibles.                                                                    |
| Konva             | 8 catégories LOGIQUES séparées (fond, zones, bâtiments, circulation, piétons, signalisation, textes, sélection/UI), rendues sur 3 couches PHYSIQUES seulement : décision mesurée, voir §11.                                                   |
| Coordonnées       | `coordonnées projet → transformation viewport → coordonnées écran`. Le viewport ne modifie jamais les données et n'est jamais stocké dans les objets.                                                                                         |
| Export            | Jamais une capture d'écran : rendu hors écran avec son propre viewport, à la résolution native de la photo ou plus.                                                                                                                           |
| Annuler/rétablir  | ≥ 100 actions. Une interaction continue (déplacer, redimensionner, pivoter, déplacer un point, modifier un chemin) = une seule action.                                                                                                        |
| Autosave          | Jamais pendant un glisser : écriture à la fin de l'interaction, après une courte inactivité.                                                                                                                                                  |
| Priorité          | Le parcours complet (nouveau camp → plan → photo → zones, routes, flèches, corridor, texte → calques → sauvegarde → réouverture identique → export) doit être fiable avant toute fonction avancée.                                            |

---

## 1. Audit du projet existant

| Élément                  | Constat                                                                                                                           |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| Dépôt                    | `nicolasfbou/app-plan-camp`                                                                                                       |
| Historique git           | Aucun commit : dépôt **vide**                                                                                                     |
| Stack existante          | Aucune                                                                                                                            |
| Composants réutilisables | Aucun                                                                                                                             |
| Design system            | Aucun. La maquette fournie (sidebar sombre, panneau droit « Outils de dessin / Calques / Propriétés ») sert de référence visuelle |
| Environnement dispo      | Node 22, npm 10, Chromium (tests Playwright possibles)                                                                            |

**Conclusion :** projet _greenfield_. Rien à préserver, rien à migrer. On peut choisir le stack
le plus adapté, sans dette existante.

---

## 2. Stack recommandé

| Besoin             | Choix                                                              | Pourquoi                                                                |
| ------------------ | ------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| Langage            | **TypeScript** (strict)                                            | Modèle de données riche, refactorings sûrs                              |
| Build / dev        | **Vite**                                                           | Démarrage instantané, build statique simple                             |
| UI                 | **React 19**                                                       | Écosystème, compatible avec react-konva                                 |
| Moteur graphique   | **Konva.js + react-konva**                                         | Voir §3                                                                 |
| État               | **Zustand + Immer** (patches)                                      | Store unique, sélecteurs fins (peu de rerenders), undo/redo par patches |
| Style / composants | **Tailwind CSS + Radix UI** (via shadcn/ui)                        | Accessibles, sobres, proches de la maquette, pas de lib lourde          |
| Icônes UI          | **lucide-react**                                                   | Cohérent, libre                                                         |
| Stockage local     | **IndexedDB via Dexie**                                            | Stocke de gros Blobs (photos HD) + JSON, fonctionne hors ligne          |
| Import PDF         | **pdf.js (pdfjs-dist)**                                            | Standard, rendu d'une page choisie                                      |
| Export PDF         | **jsPDF**                                                          | Formats Lettre / Légal / 11x17 / A4 / A3, portrait/paysage              |
| Fichier projet     | **JSZip**                                                          | Un fichier `.campplan` portable (voir §6)                               |
| Géométrie          | **clipper2-js** (offset de polylignes)                             | Corridors à largeur réelle, hachures, surfaces                          |
| Tests              | **Vitest** (logique) + **Playwright** (éditeur réel dans Chromium) |                                                                         |
| Qualité            | ESLint + Prettier + `tsc --noEmit` en CI (GitHub Actions)          |                                                                         |

**Type d'application :** application web (SPA) installable en **PWA**, qui fonctionne hors ligne
(utile sur un camp éloigné). Desktop en priorité (souris/trackpad), tactile supporté.
Un emballage Tauri/Electron reste possible plus tard sans réécriture.

**Pas de backend en V1** : tout est local (IndexedDB + fichiers `.campplan`). L'architecture isole
la persistance derrière une interface `ProjectRepository`, pour brancher plus tard un backend
(ex. Supabase/Postgres + stockage objet) pour la collaboration, les permissions et le partage.

---

## 3. Moteur graphique : comparaison rapide

| Critère                                                        | **Konva**                                           | Fabric.js                              | tldraw SDK                         | OpenLayers (image statique) |
| -------------------------------------------------------------- | --------------------------------------------------- | -------------------------------------- | ---------------------------------- | --------------------------- |
| Architecture en calques                                        | ✅ `Konva.Layer` = un canvas par calque             | ❌ un seul canvas                      | ✅                                 | ✅                          |
| Fond immobile mis en cache                                     | ✅ calque dédié, jamais redessiné pendant l'édition | ⚠️ redessiné avec le reste             | ✅                                 | ✅                          |
| Intégration React déclarative                                  | ✅ react-konva (le store reste la source de vérité) | ⚠️ modèle objet impératif, double état | ✅                                 | ⚠️                          |
| Transformer (redim., rotation)                                 | ✅ natif                                            | ✅ natif                               | ✅                                 | ❌ à coder                  |
| Formes personnalisées (flèches le long d'un chemin, corridors) | ✅ `Shape` + `sceneFunc`                            | ✅                                     | ⚠️ contraint par son modèle        | ⚠️                          |
| Performance (centaines d'objets)                               | ✅ bonne, hit-graph séparé                          | ✅                                     | ✅                                 | ✅                          |
| Licence                                                        | MIT                                                 | MIT                                    | ⚠️ licence commerciale / filigrane | BSD                         |
| Édition de texte in-place                                      | ⚠️ à faire (textarea HTML superposé)                | ✅                                     | ✅                                 | ❌                          |

**Recommandation : Konva + react-konva.** Le modèle un-canvas-par-calque correspond exactement au
principe « photo intacte en dessous, calques au-dessus ». Le seul manque (édition de texte) se
règle avec un `<textarea>` HTML positionné au-dessus du texte, une technique courante.
OpenLayers sera réévalué si le **géoréférencement réel** devient prioritaire (V3).

---

## 4. Garantie « photo originale intacte »

C'est une exigence du produit, elle est donc appliquée techniquement :

1. **Le fichier importé est stocké tel quel** (Blob d'origine, octets identiques) avec son
   **empreinte SHA-256**. On ne ré-encode jamais, on ne compresse jamais, on ne recadre jamais.
2. L'affichage passe par `createImageBitmap(blob)` : pas de filtre, pas de sharpen, pas d'upscale.
   Lissage d'image désactivé au zoom > 100 % pour voir les vrais pixels.
3. Le calque de fond est **verrouillé par construction** : il n'est pas un « objet » du modèle,
   il n'écoute aucun événement (`listening: false`) et aucune commande ne peut le modifier.
4. À la réouverture, l'empreinte est revérifiée. Toute différence est signalée.
5. L'export compose la photo à sa **résolution native** et dessine les calques par-dessus. Le
   fichier source n'est jamais modifié.
6. **Aucune IA générative** dans la chaîne de traitement de l'image.

**Cas du PDF (à noter honnêtement) :** un PDF n'est pas une image. Il faut le « rastériser » à
une résolution donnée (ex. 200–300 DPI) pour dessiner dessus. On conserve **le PDF d'origine + le
numéro de page + la résolution utilisée**. L'image rastérisée est un dérivé qu'on peut
regénérer à tout moment.

---

## 5. Système de coordonnées et échelle

- **Coordonnées « monde » = pixels de l'image d'origine.** Chaque objet est stocké en pixels
  image, indépendamment du zoom et de l'écran. Un objet placé sur un bâtiment reste sur ce
  bâtiment, quelle que soit la résolution d'export.
- **Calibration :** l'utilisateur trace une ligne entre deux points connus et entre une
  distance réelle. On obtient `metresParPixel`. Distances, longueurs de chemins et surfaces en
  découlent. L'interface affiche toujours **« ≈ approximatif (image non géoréférencée) »**.
- **Évolution prévue :** remplacer `metresParPixel` par une transformation affine (2 à 3
  points de contrôle GPS) pour un vrai géoréférencement, sans changer le modèle des objets.

---

## 6. Modèle de données

### 6.1 Hiérarchie

```
Site (camp)            ex. « Camp 105 »
 └─ Plan               ex. « Circulation hiver »
     ├─ BaseImage      photo/PDF d'origine (Blob) + hash + dimensions
     ├─ Calibration?   échelle
     ├─ Layer[]        calques ordonnés
     ├─ PlanObject[]   objets éditables
     ├─ Legend?        légende (config)
     ├─ TitleBlock?    cartouche
     └─ Metadata       auteur, dates, révision…
Template               plan sans photo (styles, légende, signalisation) réutilisable
```

### 6.2 Types (esquisse TypeScript)

```ts
type ID = string; // nanoid

interface Site {
  id: ID;
  name: string;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

interface Plan {
  id: ID;
  siteId: ID;
  name: string;
  kind:
    | 'general'
    | 'circulation-hiver'
    | 'circulation-ete'
    | 'securite'
    | 'evacuation'
    | 'deneigement'
    | 'livraisons'
    | 'travaux-futurs'
    | 'autre';
  baseImageId: ID;
  calibration?: { p1: Pt; p2: Pt; realDistanceM: number; metersPerPixel: number };
  northAngleDeg: number;
  layers: Layer[]; // ordre = ordre d'affichage
  objects: Record<ID, PlanObject>;
  legend?: LegendConfig;
  titleBlock?: TitleBlock;
  schemaVersion: number; // migrations futures
  revision: number;
  createdAt: string;
  updatedAt: string;
}

interface BaseImage {
  id: ID;
  blob: Blob;
  mime: string;
  sha256: string;
  width: number;
  height: number;
  source: { kind: 'image' } | { kind: 'pdf'; pdfBlob: Blob; page: number; dpi: number };
}

interface Layer {
  id: ID;
  name: string;
  visible: boolean;
  locked: boolean;
  opacity: number;
  category?:
    | 'batiments'
    | 'vehicules'
    | 'pietons'
    | 'stationnement'
    | 'securite'
    | 'technique'
    | 'entreposage'
    | 'signalisation'
    | 'textes'
    | 'mesures'
    | 'hiver';
}

interface BaseObject {
  id: ID;
  type: ObjectType;
  name: string;
  layerId: ID;
  presetId?: string; // ex. 'zone.pietonne', 'circ.vehicules-lourds'
  visible: boolean;
  locked: boolean;
  rotation: number; // degrés
  style: Style;
  meta: Record<string, unknown>; // extensible : inspections, photos terrain…
  createdAt: string;
  updatedAt: string;
}

type PlanObject =
  | (BaseObject & { type: 'rect'; x: number; y: number; w: number; h: number; cornerRadius: number })
  | (BaseObject & { type: 'ellipse'; cx: number; cy: number; rx: number; ry: number })
  | (BaseObject & { type: 'polygon'; points: Pt[] }) // zones
  | (BaseObject & { type: 'polyline'; points: Pt[]; curved: boolean }) // lignes, chemins
  | (BaseObject & { type: 'flow'; points: Pt[]; curved: boolean; arrows: ArrowSpec }) // circulation
  | (BaseObject & {
      type: 'corridor';
      points: Pt[];
      widthM: number;
      fill: 'plein' | 'transparent' | 'pointille' | 'hachure';
      pedestrianIcons?: { everyM: number };
    })
  | (BaseObject & {
      type: 'parking';
      points: Pt[];
      stalls: StallSpec;
      stallOverrides: Record<string, StallOverride>;
    })
  | (BaseObject & { type: 'text'; x: number; y: number; text: string; font: FontSpec; label?: LabelSpec })
  | (BaseObject & { type: 'icon'; x: number; y: number; size: number; symbolId: string })
  | (BaseObject & { type: 'poi'; x: number; y: number; symbolId?: string })
  | (BaseObject & { type: 'measure'; points: Pt[]; mode: 'distance' | 'surface' })
  | (BaseObject & { type: 'group'; childIds: ID[] });

interface Style {
  fill?: string;
  fillOpacity?: number;
  stroke?: string;
  strokeWidth?: number;
  strokeOpacity?: number;
  dash?: 'solid' | 'dashed' | 'dotted' | number[];
  pattern?: 'none' | 'hachure' | 'quadrillage' | 'points';
}

interface ArrowSpec {
  direction: 'forward' | 'backward' | 'both';
  size: number;
  spacingPx: number;
  showEndArrow: boolean;
}
```

Principes :

- **Rien n'est aplati.** Chaque élément reste un objet indépendant, avec ID, type, géométrie,
  style, calque, visibilité, verrouillage et métadonnées.
- Les **presets** (zone piétonne, circulation véhicules lourds, voie d'urgence, dépôt de neige…)
  sont des _données_ (`presets.ts`) : nom, style et calque cible par défaut. Ajouter un preset
  ne demande aucun nouveau code.
- Les **stationnements** stockent des paramètres (taille des cases, orientation, rangées,
  espacement). Les cases sont _calculées_ et les retouches manuelles sont gardées dans
  `stallOverrides`.
- Les **symboles** (STOP, extincteur, premiers soins…) sont une bibliothèque SVG interne,
  extensible avec les PNG/SVG importés par l'utilisateur (stockés comme `Asset` Blob).

### 6.3 Format de fichier `.campplan`

Archive ZIP :

```
projet.campplan
 ├─ manifest.json        version du format, application, date
 ├─ plan.json            Plan (objets, calques, calibration, métadonnées)
 ├─ base/original.jpg    fichier d'origine, octets identiques
 ├─ base/source.pdf      (si import PDF)
 ├─ assets/*.svg|png     icônes personnalisées
 └─ thumbnail.png        aperçu
```

Image, objets, calques, propriétés, calibration et métadonnées sont stockés séparément, comme
demandé. Le JSON reste lisible et versionné (`schemaVersion` et migrations).

> Esquisse de la phase 0. Le format réellement implémenté (phase 3) est décrit au §14.1.

---

## 7. Architecture applicative

```
src/
 ├─ app/                  shell, routing (Sites → Plans → Éditeur), layout
 ├─ domain/               ⚠️ pur TypeScript, sans React ni Konva, testé unitairement
 │   ├─ model.ts          types ci-dessus
 │   ├─ presets.ts        zones, circulation, hiver, bâtiments
 │   ├─ geometry/         offset corridor, flèches le long d'un chemin, aire, longueur,
 │   │                    génération des cases de stationnement, hit-tests
 │   ├─ scale.ts          calibration et conversions
 │   └─ migrations.ts
 ├─ store/
 │   ├─ planStore.ts      Zustand + Immer : plan courant, actions métier
 │   ├─ history.ts        undo/redo par patches Immer (≥ 100 étapes, transactions)
 │   ├─ selection.ts      sélection, outil actif, presse-papiers
 │   └─ viewport.ts       zoom et pan (hors historique)
 ├─ editor/
 │   ├─ Stage.tsx         Konva Stage : zoom molette, pan, pinch tactile
 │   ├─ layers/           BaseImageLayer (cache, non interactif), ObjectsLayer, OverlayLayer
 │   ├─ shapes/           un composant par type d'objet
 │   ├─ tools/            machine d'état par outil (rect, polygone, flux, corridor…)
 │   ├─ Transformer.tsx
 │   └─ TextEditorOverlay.tsx
 ├─ panels/               barre d'outils, calques, propriétés, bibliothèque, légende
 ├─ persistence/
 │   ├─ ProjectRepository.ts   interface (local aujourd'hui, serveur demain)
 │   ├─ indexedDbRepo.ts       Dexie
 │   ├─ campplanFile.ts        import/export .campplan
 │   └─ autosave.ts
 ├─ import/               image, PDF (sélection de page)
 └─ export/               rendu hors écran à résolution native, PNG/JPG, PDF + mise en page
```

### Décisions clés

- **Store = source de vérité unique.** Konva ne fait qu'afficher. Chaque modification passe par
  une action du store. Undo/redo, autosave et, plus tard, la collaboration s'appuient tous sur
  ce même flux.
- **Undo/redo par patches Immer**, avec des _transactions_ : un glisser-déposer produit une seule
  entrée d'historique, pas soixante. Le zoom, le pan et la sélection ne vont pas dans
  l'historique.
- **Les outils sont des machines d'état** (`idle → drawing → editing`) découplées du rendu.
  Chaque outil se teste isolément et s'ajoute sans toucher aux autres.
- **Performance :**
  - la photo est sur son propre `Konva.Layer`, jamais redessinée pendant l'édition ;
  - un composant par objet, abonné à son objet seul (`React.memo` + sélecteur Zustand), donc
    seul l'objet modifié se redessine ;
  - pendant un glisser, mise à jour Konva directe puis commit dans le store au relâchement ;
  - objets hors écran ignorés (culling) ; `perfectDrawEnabled: false` ;
  - les calculs géométriques lourds (offset des corridors) sont mémoïsés par objet.
- **Export :** Stage Konva hors écran à la taille native de l'image, dessin de tous les calques
  visibles sans l'interface, puis mise en page PDF (titre, légende, cartouche, échelle, Nord,
  marges) via jsPDF. V1 : PDF avec plan rastérisé haute résolution (≥ 200 DPI au format
  choisi). V2 : calques en vectoriel dans le PDF pour une netteté parfaite.
- **Protection contre les erreurs :** autosave différé (≈ 2 s après la dernière modification)
  dans IndexedDB ; journal de récupération après crash ; indicateur « modifications non
  enregistrées » ; `beforeunload` ; confirmation avant toute suppression de plan ou de site ;
  `navigator.storage.persist()` pour que le navigateur ne purge pas les données.

---

## 8. Découpage en phases

Chaque étape est livrée testable : `tsc`, build, tests unitaires, test Playwright de
l'éditeur, puis vérification d'un aller-retour sauvegarde → réouverture.

### V1 : base réellement utilisable

| Phase                         | Contenu                                                                                                                                                                                                                                                                                            | Critère d'acceptation                                  |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| **0. Fondations**             | Vite + React + TS strict, Tailwind/Radix, ESLint, Vitest, Playwright, CI GitHub Actions, shell de l'app (sidebar, barre du haut, panneau droit)                                                                                                                                                    | CI verte, app vide qui s'affiche                       |
| **1. Plan de base**           | Import PNG/JPG/WEBP/PDF (choix de page), calque de fond verrouillé, hash SHA-256, zoom molette/boutons, pan, 100 %, adapter à l'écran, plein écran, pinch tactile                                                                                                                                  | Photo 8000×6000 fluide ; hash identique avant et après |
| **2. Dessin de base**         | Sélection, rectangle, rectangle arrondi, ellipse, polygone, ligne, polyligne, texte, étiquette ; déplacer, redimensionner, pivoter ; panneau Propriétés                                                                                                                                            | Chaque objet créé est modifiable après coup            |
| **3. Calques + historique**   | Calques (afficher/masquer, verrouiller, renommer, réordonner, opacité, « solo ») ; undo/redo ≥ 100 ; raccourcis (Ctrl+Z/Y/C/V/D/S, Suppr, Échap, flèches ± Shift)                                                                                                                                  | 100 actions annulables puis rétablies à l'identique    |
| **4. Persistance**            | Sites → plans multiples, IndexedDB, autosave, récupération après crash, export/import `.campplan`                                                                                                                                                                                                  | Fermer l'onglet, rouvrir : tout est là                 |
| **5. Circulation et piétons** | Outil flux (flèches le long du chemin : sens, double sens, fréquence, taille), presets véhicules, véhicules lourds, urgence, entrée, sortie ; outil corridor piéton (largeur, plein/transparent/pointillé/hachuré, icônes piétons) ; zones prédéfinies ; bibliothèque d'icônes et de signalisation | Recréer le plan de la maquette de référence            |
| **6. Export**                 | PNG haute résolution, JPG, PDF Lettre/Légal/11x17/A4/A3, portrait/paysage, marges, titre ; export « plan seul »                                                                                                                                                                                    | PDF imprimable, propre, sans interface                 |

### V2 : fonctions avancées

7. Calibration, mesures de distance et de surface, règle, barre d'échelle, flèche Nord
8. Légende automatique (éléments choisis, déplaçable, redimensionnable) et cartouche professionnel
9. Générateur de cases de stationnement, avec retouche manuelle
10. Flèches courbes, groupes, alignement et distribution, import de PNG/SVG personnalisés
11. Modèles réutilisables (ex. « Modèle circulation PAMM »)
12. Mode hiver : dépôt de neige, trajets loader/grader/tracteur, zones à ne pas enneiger, priorités, obstacles
13. PDF vectoriel

### V3 : plateforme

Backend, comptes, permissions, plans partagés, historique des versions, collaboration temps réel
(le store basé sur des patches s'y prête, par ex. via Yjs), photos terrain, inspections,
géoréférencement réel.

---

## 9. Risques identifiés

| Risque                                                                     | Impact                                                      | Mitigation                                                                                                                                                                  |
| -------------------------------------------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Limite de taille des canvas** (≈ 16 384 px de côté, Safari/iOS plus bas) | Photos drone très grandes impossibles à afficher en un bloc | Détection à l'import ; au-delà de la limite, affichage en **tuiles** (l'original reste intact et stocké tel quel). Tuilage prévu en phase 1 si vos images dépassent ~16k px |
| Mémoire navigateur (photo 100 MP ≈ 400 Mo décompressée)                    | Lenteur ou crash                                            | `ImageBitmap`, tuiles, un seul plan ouvert à la fois                                                                                                                        |
| PDF = rastérisation                                                        | Pas « pixel pour pixel » au sens strict                     | PDF d'origine conservé, DPI choisi par l'utilisateur, dérivé regénérable                                                                                                    |
| Édition de texte sur canvas                                                | UX moins naturelle                                          | Textarea HTML superposé (technique éprouvée)                                                                                                                                |
| Export PDF très grand format                                               | Fichier lourd, lent                                         | Qualité réglable ; export dans un Web Worker ; vectoriel en V2                                                                                                              |
| Stockage local purgé par le navigateur                                     | Perte de données                                            | `storage.persist()`, rappel d'export `.campplan`, backend en V3                                                                                                             |
| Mesures perçues comme exactes                                              | Erreurs de chantier                                         | Mention « approximatif » partout tant que l'image n'est pas géoréférencée                                                                                                   |
| Licences des pictogrammes (ISO 7010, signalisation routière)               | Juridique                                                   | Pictogrammes dessinés en interne ou sets libres (CC0/MIT) ; import de vos propres symboles                                                                                  |
| Périmètre très large                                                       | V1 qui n'aboutit pas                                        | Phasage strict : aucun bouton non fonctionnel dans l'interface                                                                                                              |

---

## 10. Questions ouvertes (réglées avant la phase 0, voir §0)

1. **Web (navigateur/PWA) ou application installée** (Windows) ? Recommandation : web/PWA d'abord.
2. **Local uniquement en V1** (pas de comptes, pas de serveur) : est-ce acceptable ?
3. **Taille typique de vos photos** (ex. drone 20 MP, orthomosaïque 30 000 px) ? Cela détermine
   si le tuilage est nécessaire dès la V1.
4. **Langue** : interface en français uniquement, ou français et anglais ?
5. Avez-vous une **charte graphique** (logo, couleurs, cartouche client type) à respecter ?

---

## 11. Rendu Konva : mesure et décision (phase 1)

**Question :** 8 `Konva.Layer` physiques (un canvas par catégorie), ou quelques couches physiques
contenant les 8 catégories logiques ?

**Mesure** (`bench/konva-layers.mjs`) : vraie photo de drone 4896 × 3672 (18 MP), Stage 1920 × 1080,
300 objets répartis dans les catégories, déplacement continu de 120 images, médiane de 3 essais,
Chromium 141 sans GPU (rendu logiciel). Ce sont des mesures de référence dans cet environnement, pas une
garantie : sur un poste réel, les résultats dépendront du GPU, du navigateur, de la résolution et de la
densité de l'écran. L'écart relatif entre les options reste l'information utile.

| Écran                           | 8 couches physiques      | 3 couches physiques      | Écart                       |
| ------------------------------- | ------------------------ | ------------------------ | --------------------------- |
| 1920 × 1080, densité 1x         | 1 344 Mo · 29,9 ms/image | 1 023 Mo · 17,0 ms/image | −320 Mo · 1,8 × plus fluide |
| 1920 × 1080, densité 2x (HiDPI) | 2 619 Mo · 95,5 ms/image | 1 513 Mo · 37,4 ms/image | −1,1 Go · 2,6 × plus fluide |

Chaque couche Konva alloue un canvas de la taille de l'écran (× densité²) plus un canvas de détection
des clics : le coût croît avec le nombre de couches, même vides.

**Décision : 3 couches physiques.**

| Couche physique | Contenu                                                                                | Écoute les événements |
| --------------- | -------------------------------------------------------------------------------------- | --------------------- |
| `background`    | Photo d'origine (verrouillée)                                                          | Non                   |
| `content`       | 6 `Konva.Group` nommés : zones, bâtiments, circulation, piétons, signalisation, textes | Oui (phase 2)         |
| `overlay`       | Sélection, poignées, tracés en cours (phase 2)                                         | Oui                   |

Les 8 catégories restent séparées **dans les données** (`Layer.tier`) et **dans l'arbre Konva**
(groupes nommés). Si un jour une catégorie doit être isolée physiquement (ex. glisser un objet sans
redessiner les autres), on pourra la déplacer temporairement dans `overlay` sans changer le modèle.

## 12. Import, intégrité et affichage de la photo (phase 1)

- **Format réel** détecté par les octets (pas l'extension). Dimensions et orientation EXIF lues dans
  l'en-tête **avant tout décodage** (`src/domain/image/header.ts`).
- **Seuils** (`sizeAssessment.ts`) : normal ≤ 50 MP et côtés ≤ 16 384 px ; grande jusqu'à 120 MP ou côté
  > 16 384 px (avertissement, ouverture permise) ; potentiellement dangereuse au-delà de 120 MP ou d'un côté
  > 32 767 px (confirmation explicite). Le message indique largeur, hauteur, mégapixels, taille du
  > fichier, mémoire décodée et raison. Rien n'est jamais compressé ni réduit.
- **Stockage** : les octets d'origine sont écrits tels quels avec leur SHA-256. À chaque ouverture,
  l'empreinte est recalculée ; en cas d'écart, le fond n'est pas affiché. « Télécharger l'original »
  restitue le fichier identique à l'octet près (vérifié par les tests e2e).
- **Orientation EXIF** : appliquée au décodage d'affichage (`createImageBitmap`, `imageOrientation: 'from-image'`).
  L'original n'est pas réécrit. L'espace de coordonnées du projet est celui de l'image affichée ; ses
  dimensions sont vérifiées contre celles décodées par le navigateur.
- **PDF** : pdf.js (build « legacy » pour les navigateurs non à jour), chargé à la demande. Le PDF
  original est conservé intact (octets, SHA-256). La page sélectionnée est **rastérisée** à une résolution
  définie (défaut : la plus fine sous 50 MP), puis enregistrée en PNG à compression sans perte. Attention :
  la rastérisation elle-même fige la page à cette résolution ; le fond n'est donc pas identique à la page
  vectorielle, seulement à son rendu à cette résolution. Page, résolution, nombre de pages et SHA-256 du
  PDF sont conservés : le rendu peut être refait depuis l'original.
- **Affichage** : à ≥ 1 pixel écran par pixel image, lissage désactivé (pixels exacts ; à 100 % la
  position est arrondie au pixel entier → correspondance 1:1 vérifiée pixel par pixel en e2e). Au fort
  dézoom (< 25 %), une **pyramide d'affichage** (copies 1/4, 1/8… générées en mémoire, jamais enregistrées)
  évite le moiré et accélère le rendu ; l'original est utilisé dès qu'il apporte plus de détail.
- **Préférence de vue** (centre + zoom) : table IndexedDB séparée `viewPrefs`, hors document, hors
  `.campplan`, supprimée avec le plan.

## 13. Édition du plan (phase 2)

- **Coordonnées** : toute géométrie est créée, modifiée et stockée en pixels image. Les outils
  convertissent la position du pointeur avec `screenToImage`, les champs du panneau affichent des
  pixels image. Vérifié en e2e à 12,5 / 25 / 50 / 100 / 200 / 400 % et après redimensionnement de la
  fenêtre, et par `bench/real-photo-check.mjs` sur une photo réelle (écart mesuré : 0 px).
- **Convention de rendu** : chaque objet est un nœud Konva placé au centre de sa géométrie et pivoté
  autour de ce centre (rectangle, ellipse, boîte englobante des points, centre du texte).
- **Transformer** : pendant le geste, Konva modifie le nœud (aucune écriture dans le store) ; à la fin,
  `normalizeTransform` intègre l'échelle dans la géométrie (largeur, rayons, points, taille de police)
  et le nœud revient à l'échelle 1. Aucun `scaleX` / `scaleY` n'est jamais stocké. La rotation reste
  un angle (un rectangle pivoté ne peut pas s'exprimer autrement).
- **Sommets** : avant d'éditer un sommet d'un polygone pivoté, la rotation est intégrée aux points
  (même rendu), sinon le centre de rotation bougerait avec le sommet.
- **Historique** : un glisser, un redimensionnement, une rotation ou un déplacement de sommet = une
  entrée. Les modifications répétées d'un même champ (flèches clavier, curseur d'opacité, saisie
  du nom ou du texte) sont fusionnées si elles se suivent à moins d'une seconde.
- **Conflits de pointeur** : main, Espace et bouton du milieu sont interceptés en phase de capture,
  avant Konva ; ils déplacent la caméra et jamais un objet. Avec l'outil Sélection, glisser dans le
  vide ne fait rien (clic = désélection). Tactile : deux doigts = déplacement / zoom de la vue.
- **Zones de clic** : les surfaces ont toujours un remplissage de clic (même à opacité 0) ; les
  traits ont une zone de clic d'au moins 12 px écran, recalculée par palier de zoom (puissances de 2)
  pour ne pas redessiner tous les objets à chaque cran de molette.
- **Épaisseurs par défaut** : exprimées en pixels écran au zoom de création puis stockées en pixels
  image, pour que le trait soit visible quel que soit le zoom où l'on dessine.
- **Verrouillage** : un objet (ou un calque) verrouillé reste visible et sélectionnable (pour pouvoir
  le déverrouiller) mais ne peut être ni déplacé, ni transformé, ni supprimé ; la règle est appliquée
  dans le domaine (`replaceObject`, `removeObject`…), pas seulement dans l'interface.
- **Sauvegarde** : autosave après chaque action. À la fermeture ou au masquage de la page, si des
  modifications ne sont pas encore dans IndexedDB, un journal de récupération est écrit de façon
  synchrone dans `localStorage`, validé puis appliqué à la réouverture.
- **Performance mesurée** (`bench/objects-performance.mjs`, photo réelle de 18 MP, sans GPU) :
  100 / 500 / 1 000 objets ouverts en 0,5 / 0,6 / 0,7 s ; déplacement de la vue 60 / 59 / 50-54 ips ;
  glisser d'un objet 59-60 ips ; sélection ≈ 30 ms. Aucune élimination hors écran n'est nécessaire
  à ce stade ; toujours 3 couches Konva physiques.

---

## 14. Calques, sélection multiple, sommets et fichier `.campplan` (phase 3)

### 14.1 Format `.campplan` (version 1)

Archive ZIP (fflate, fichiers binaires stockés sans recompression) :

```
Camp 105 - Plan général.campplan
 ├─ manifest.json                        format « campplan », formatVersion, schemaVersion, application,
 │                                       exportedAt, camp, plan, planSha256, files[], presets, counts
 ├─ plan.json                            document complet (objets, calques, calibration, métadonnées)
 ├─ fichiers/background-<sha16>.<ext>    photo d'origine, octets identiques
 └─ fichiers/pdf-<sha16>.pdf             PDF d'origine (si le fond vient d'un PDF)
```

- Chaque fichier est décrit dans `files[]` : chemin, rôle, `blobId`, type MIME, taille, SHA-256.
  L'export relit les octets stockés et vérifie leur SHA-256 avant d'écrire l'archive.
- `planSha256` protège `plan.json` ; `presets` recopie les modèles utilisés par le plan.
- **Lecture = vérification complète AVANT toute écriture** : archive ZIP valide, entrées attendues
  seulement (taille déclarée plafonnée avant décompression), manifeste, format, version
  (migrations `FORMAT_MIGRATIONS` ; version plus récente refusée avec un message clair), empreinte
  de `plan.json`, validation zod + migrations du document, taille et SHA-256 de chaque fichier,
  cohérence avec la référence de la photo. Toute anomalie → `CampplanError`, rien n'est créé.
- **Écriture** : fichiers d'origine d'abord (nouveaux identifiants, SHA revérifié), puis camp
  éventuel + plan + nettoyage des fichiers de la version remplacée dans **une seule transaction**
  IndexedDB (`saveImportedPlan`). Un échec (ex. quota) ne crée ni camp vide ni plan partiel ; les
  fichiers déjà écrits restent orphelins et sont supprimés par le nettoyage différé (§12).
- **Jamais d'écrasement silencieux** : si l'identifiant du plan existe (lu sans validation, donc même
  un plan illisible compte), l'import crée par défaut une **copie** (nouvel identifiant, nom
  « … (importé) »). Le **remplacement** exige un choix explicite et une case de confirmation, et le
  plan remplacé reste dans son camp.

### 14.2 Schéma v2

`schemaVersion` passe à 2 : chaque objet a un `groupId` (null = non groupé). Migration 1 → 2 :
`groupId: null`. Un plan v1 s'ouvre, se modifie et se réenregistre en v2 (testé en e2e).

### 14.3 Calques

- `doc.layers` est l'ordre d'affichage. Dans la couche physique « content », chaque calque est un
  `Konva.Group` (id `layer-<id>`, nom `user-layer tier-<catégorie>`), dans cet ordre : réordonner les
  calques change réellement le rendu, **sans nouvelle couche physique** (toujours 3 canvas).
- Créer (au-dessus, devient actif), renommer, dupliquer (juste au-dessus, objets copiés, groupes
  recréés), monter / descendre, afficher / masquer, « afficher seulement », verrouiller, supprimer
  (calque vide uniquement ; au moins un calque).
- Un calque masqué ne crée aucun nœud Konva pour ses objets (mémoire et rendu nuls).
- **Calque actif** : les nouveaux objets y vont. Sans calque actif, un objet va dans le calque
  **le plus bas** (normalement celui d'origine) de sa catégorie : un calque ajouté ne capte pas les
  objets sans avoir été choisi. Un calque masqué ou verrouillé ne reçoit jamais d'objet (message).

### 14.4 Sélection multiple et groupes

- Maj + clic (ajoute / retire), rectangle de sélection dans le vide, Ctrl+A (objets modifiables),
  Maj + clic dans la liste des calques.
- Déplacer, dupliquer, copier / coller, supprimer, couleur de remplissage / trait, calque,
  verrouillage : sur toute la sélection, en **une** entrée d'historique. Le glisser de plusieurs
  nœuds ouvre une transaction ; chaque nœud valide sa position ; la transaction est fermée en
  micro-tâche après le dernier.
- Grouper (Ctrl+G) / dégrouper (Ctrl+Maj+G) : un clic sur un membre sélectionne tout le groupe.
- Verrous : les objets verrouillés d'une sélection ne sont pas attachés au Transformer (cadre
  pointillé) et sont ignorés par toutes les opérations du domaine.
- Poignées : sélection multiple ou petit objet (< 40 px écran) → coins seuls. Une poignée de côté
  déformerait en biais un objet pivoté, et sur un petit objet elle recouvrirait la zone de glisser.

### 14.5 Sommets

Double clic sur un polygone ou une polyligne → mode sommets : glisser un sommet ; glisser un « + »
(milieu de segment) insère un sommet (insertion + glisser = une action) ; clic puis Suppr retire le
sommet (minimum 3 pour un polygone, 2 pour une ligne). « Fermer en polygone » transforme une
polyligne en zone ; « Convertir en polygone » transforme un rectangle (rotation intégrée) pour en
ajuster les coins. Tout est annulable et enregistré.

### 14.6 Mesures

- Photo réelle du Camp 105 (4000 × 2250, 9 MP) — `bench/camp105-phase3.mjs` : 21 objets sur 7 calques
  tracés avec les vrais outils ; réouverture identique ; 126 vérifications d'attache (6 zooms,
  12,5 → 400 %), écart maximal 0 px ; export .campplan 3,35 Mo ; réimport dans un navigateur vide :
  objets, calques et SHA-256 identiques. Les zones tracées sont des **exemples de test**, pas un plan
  de circulation approuvé.
- Performance (`bench/objects-performance.mjs`, même photo, Chromium sans GPU ; valeurs de
  référence, pas des garanties) : 100 / 500 / 1 000 objets ouverts en 0,4 / 0,55 / 0,65 s ; vue
  60 / 59 / 53 ips ; glisser d'un objet 60 ips ; sélection ≈ 30 ms.

---

## 15. Circulation et zones opérationnelles (phase 4)

### 15.1 Modèle (schéma v3)

Aucune architecture parallèle : les nouveaux outils créent des objets du modèle existant (mêmes
calques, sélection multiple, groupes, verrous, annuler / rétablir, sauvegarde, `.campplan`).

| Objet                        | Géométrie                        | Paramètres                                                                                                                                                                                                      |
| ---------------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Trajet de véhicules (`flow`) | polyligne (les points des clics) | catégorie (légers, lourds, livraison, service, urgence, générale, personnalisé), sens (tracé, inverse, double), flèches affichées, taille et espacement des flèches, trait (couleur, épaisseur, opacité, style) |
| Corridor piéton (`corridor`) | polyligne = axe du corridor      | largeur (px image), remplissage, bordure, pictogrammes (affichés, espacement, taille, orientés dans le sens du déplacement)                                                                                     |
| Pictogramme (`icon`)         | point (centre)                   | pictogramme de la bibliothèque ou importé, taille, rotation, texte (limite de vitesse), opacité                                                                                                                 |
| Zone (`zone`)                | rectangle, ellipse, polygone     | + pictogramme et nom affichés au centre                                                                                                                                                                         |

- Catégories de calques ajoutées : Stationnement, Livraison et débarquement, Sécurité et accès.
- `doc.assets` : pictogrammes importés (octets d'origine stockés à part, SHA-256) ;
  `doc.crossingReviews` : décisions sur les croisements ; `plan.display` : limites d'affichage.
- Migration 2 → 3 : les trois calques sont ajoutés au-dessus des zones, les nouveaux champs reçoivent
  des valeurs neutres ; aucune géométrie ne change. Testée sur un vrai document de format 2 (unitaire
  et navigateur).

### 15.2 Flèches et corridors : calculés, jamais stockés

- **Flèches** : `marksAlongPath` place des repères régulièrement le long du tracé ; chaque flèche
  tient entièrement sur UN segment et suit sa direction : elle ne déborde jamais du chemin dans un
  virage (une flèche qui chevaucherait un sommet est reportée sur le segment suivant). Toutes les
  flèches d'un trajet sont dessinées dans une seule forme Konva, en un seul chemin (un remplissage,
  un liseré blanc), sans aucun objet par flèche. Double sens : ↔.
- **Corridor** : `bandOutline` calcule les deux bords à une demi-largeur de l'axe : jonctions en
  onglet, biseau à l'extérieur des angles aigus, onglet intérieur borné (demi-tours, segments
  courts). Les sommets de l'axe s'éditent comme ceux d'une polyligne ; le contour suit.
- **Tailles à l'écran** : flèches, pictogrammes des corridors et des zones, et pictogrammes placés
  restent entre `symbolMinPx` et `symbolMaxPx` pixels écran (12 et 44 par défaut, réglables pour le
  plan). Dézoomé, les repères s'espacent au lieu de se chevaucher. La géométrie n'est jamais
  modifiée par le zoom. Largeurs en pixels image, jamais présentées comme des mètres.
- **Rendu** : un bitmap par pictogramme (un SVG redessiné à chaque image est coûteux) ; les repères
  hors de l'écran ne sont pas dessinés. Toujours 3 couches Konva physiques.

### 15.3 Pictogrammes

Bibliothèque de 30 pictogrammes en 7 catégories (SVG construits à partir de formes de panneau et de
tracés lucide, licence ISC, générés par `scripts/build-glyphs.mjs`). Import PNG ou SVG : taille
≤ 2 Mo, PNG ≤ 4096 px, SVG refusé s'il contient script, gestionnaire d'événement, lien ou ressource
externe, HTML intégré, DOCTYPE / ENTITY ; il est de toute façon affiché comme une image (aucun
script exécuté). Les pictogrammes importés voyagent dans le `.campplan` (format 2, rôle `symbol`).

### 15.4 Analyse des croisements

`detectCrossings` repère les points où un trajet de véhicules coupe l'axe d'un corridor piéton, ou le
longe à moins d'une demi-largeur (objets affichés seulement, rotation comprise). Marqueurs discrets ;
pour chaque croisement : consulter, point de vigilance, note, « vérifié : masquer », rouvrir. Les
décisions sont retrouvées par paire d'objets et proximité, et disparaissent avec l'objet supprimé
(dans la même action). C'est une **aide à la planification**, présentée comme telle : jamais une
certification de sécurité. Une voie d'urgence est une catégorie de tracé, pas une garantie.

### 15.5 Mesures

- Camp 105 (photo réelle, `bench/camp105-phase4.mjs`) : 17 objets tracés avec les vrais outils
  (2 trajets, 2 corridors, 4 zones, 6 pictogrammes, 3 étiquettes) sur des éléments visibles de la
  photo ; 1 croisement détecté et marqué « point de vigilance » ; réouverture identique ;
  102 vérifications d'attache (6 zooms), écart 0 px ; `.campplan` réimporté dans un navigateur vide :
  identique, SHA-256 de la photo identique, objets modifiables. Disposition **illustrative**, à
  valider sur le terrain.
- Performance (`MIX=phase4 bench/objects-performance.mjs` : trajets de 40 sommets, corridors de 20
  sommets avec pictogrammes, pictogrammes, zones avec badge ; Chromium sans GPU ; valeurs de
  référence, pas des garanties) :

  | Image               | Objets            | Ouverture         | Vue (ips)    | Zoom (ips)   | Glisser (ips) |
  | ------------------- | ----------------- | ----------------- | ------------ | ------------ | ------------- |
  | Camp 105, 9 MP      | 100 / 500 / 1 000 | 0,6 / 1,1 / 1,1 s | 59 / 53 / 38 | 60 / 50 / 38 | 60 / 60 / 40  |
  | Image de test 50 MP | 100 / 500 / 1 000 | 1,1 / 1,2 / 1,4 s | 60 / 50 / 40 | 60 / 45 / 37 | 60 / 58 / 38  |

### 15.6 Revue indépendante : corrections

- Pictogrammes arrivant par un `.campplan` : soumis aux mêmes vérifications qu'à l'import (SVG actif,
  PNG démesuré refusés) ; type MIME imposé par le plan, pas par le manifeste.
- Vérification SVG par liste blanche sur le document analysé (entités décodées) : animations
  (`set`, `animate`), `xml:base`, échappements CSS et règles `@` refusés.
- Croisements : une décision pour un croisement au plus (vérifier l'un ne masque plus son voisin) ;
  clés par position ; calcul partagé entre le panneau et les marqueurs.
- Corridor : demi-tour exact terminé par un bout carré (plus de pointe hors du tracé).
- Flèches : sur un tracé fait de segments courts, vu de loin, les flèches sont réduites (jamais
  sous 6 px écran) au lieu de disparaître.
- Marqueurs de croisement inactifs avec les outils de dessin (le clic ajoute le point).
- Pictogrammes : proportions d'origine conservées ; taille bornée par paliers (pas de re-rendu à
  chaque cran de zoom) ; une rotation seule ne change jamais la taille enregistrée.
- Limites d'affichage validées (4 à 400 px, min ≤ max) dans le schéma et dans l'interface.
- Import de pictogramme : taille vérifiée avant lecture, erreur de stockage signalée ; retrait des
  pictogrammes importés inutilisés.

### 15.7 Limites restantes

- Les textes et étiquettes suivent la photo (comme à l'impression) : créés très dézoomés, ils
  paraissent grands une fois zoomé. Les créer au zoom de travail.
- Détection des croisements limitée aux trajets × corridors (pas les zones piétonnes dessinées en
  polygone) ; une décision dont le tracé a été fortement déplacé n'est plus associée (elle reste
  dans le plan jusqu'à la suppression d'un des deux objets).
- Pictogrammes importés annulés puis rétablis plus d'une heure après, alors qu'un autre onglet a
  nettoyé les fichiers orphelins : le fichier peut manquer (pictogramme affiché comme emplacement).
- Au-delà d'environ 500 objets lourds (trajets de 40 sommets, corridors fléchés), la fluidité
  descend vers 36-40 ips sur cette machine sans GPU.

## 16. Plan professionnel et export (phase 5)

### 16.1 Modèle (schéma v4)

| Ajout                                    | Contenu                                                                                                                                       |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `plan.calibration` (existant, utilisé)   | deux points image + distance réelle (m) ; aucune calibration n'est jamais inventée                                                            |
| `plan.units`                             | `metric` (m, m²) ou `imperial` (pi, pi²)                                                                                                      |
| `plan.northStatus`, `plan.northAngleDeg` | `undefined` par défaut (le haut de l'image n'est PAS présumé être le nord) ; `estimated` (outil 2 clics) ; `verified` (choix explicite)       |
| `corridor.widthMeters`                   | largeur physique (null = largeur en pixels, jamais modifiée en silence)                                                                       |
| objet `dimension`                        | cote : polyligne mesurée                                                                                                                      |
| objet `stall`                            | case de stationnement : rectangle + `parentZoneId` (null si détachée)                                                                         |
| `plan.legend`                            | visible, titre, position, compacte / détaillée, taille, catégories masquées, intitulés personnalisés (les entrées elles-mêmes sont calculées) |
| `plan.titleBlock`                        | champs du cartouche, statut, date d'approbation, logo (`assets`), position                                                                    |
| `plan.print`                             | format, orientation, marges, contenu, résolution, qualité JPEG, cadrage, fond, éléments inclus, calques exclus                                |

Migration 3 → 4 : valeurs par défaut sûres (nord non défini, brouillon, Tabloïd paysage) et
`widthMeters: null` ; aucune géométrie ne change. Le `.campplan` transporte tout (logo compris,
vérifié comme un pictogramme importé).

### 16.2 Mesures honnêtes

- Mètres par pixel = distance réelle / distance en pixels des deux points de calibration.
- Incertitude relative = max(2 %, 2 px / longueur de calibration) ; doublée pour les surfaces.
  Le résultat est arrondi au pas décimal immédiatement inférieur à l'incertitude absolue et préfixé
  de « ≈ » : jamais de précision artificielle. Sans calibration : pixels de la photo.
- Corridors en mètres : largeur de rendu = largeur physique / (m par pixel), recalculée à chaque
  rendu ; donc stable au zoom, à l'enregistrement, à l'export et au réimport, et mise à jour si la
  calibration change.

### 16.3 Cases de stationnement

`generateStalls` range des cases (largeur, longueur, rangées, allée, orientation) dans le repère
pivoté de la zone ; une case n'est gardée que si ses 4 coins sont dans le contour, qu'aucun bord ne
croise le contour et qu'aucun sommet du contour n'est à l'intérieur : jamais de case hors d'une zone
irrégulière (L, polygone concave, zone pivotée). Chaque case est un objet indépendant (déplacer,
supprimer, détacher) ; régénérer ne remplace que les cases encore rattachées. Dimensions = paramètres
de dessin, pas une conformité réglementaire.

### 16.4 Moteur d'export (`src/export/`)

- **Jamais de capture d'écran.** Une surface de dessin abstraite (`Painter`, en mm de page, textes en
  points) est pilotée par la même mise en page pour trois sorties : canevas (aperçu, PNG, JPG) et PDF
  (jsPDF). L'aperçu est donc fidèle au fichier produit.
- **PDF vectoriel** : contours, surfaces, flèches, hachures (lignes réelles limitées au contour),
  textes (police Liberation Sans intégrée, licence OFL, métriques Arial : accents, « ≈ », « ² ») ;
  photo et pictogrammes en images (une seule copie par image, réutilisée). Photo : octets JPEG
  d'origine intégrés tels quels quand c'est possible (JPEG sans rotation EXIF, entier, pas beaucoup
  plus fin que nécessaire) ; sinon copie recadrée / réduite encodée en JPEG. L'original stocké n'est
  jamais modifié.
- **Mise en page** (`compose.ts`) : bandeau de titre avec statut (« NON APPROUVÉ » tant que le plan
  n'est pas approuvé), carte aux proportions exactes, colonne latérale (légende en haut, cartouche en
  bas) ou cartouche en bandeau bas ; légende sur la carte possible : le coin choisi automatiquement
  est celui qui recouvre le moins d'objets, et jamais un bâtiment (sinon elle repasse à côté).
- **Échelle d'affichage des repères** : pixels CSS imprimés par pixel image (mm par pixel ÷ 0,2646) :
  flèches et pictogrammes gardent sur le papier la taille bornée qu'ils ont à l'écran.
- **Nord** : imprimé seulement s'il a été orienté ; « Nord estimé — à vérifier » s'il est estimé.
  **Échelle** : barre (1-2-5) et échelle numérique « ≈ 1:X » seulement si le plan est calibré, calculées
  depuis l'échelle réelle de la page ; sinon « Plan non calibré — aucune échelle ».
- **Avertissements** (jamais d'échec silencieux) : texte < 6 pt pour le format, texte coupé par le
  cadre, légende trop longue (taille réduite jusqu'à 6 pt, puis entrées omises et comptées sur le
  plan), cartouche trop grand, légende sur un bâtiment, plan non calibré, nord non défini / estimé,
  photo réduite pour les limites mémoire.
- **Limites du navigateur** : canevas ≤ 16 384 px de côté et ≤ 120 Mpx. Au-delà : message clair et
  résolution proposée (bouton « Utiliser … ») ; la photo du PDF est réduite automatiquement (signalé).
- **PNG / JPG** : « page » (identique au PDF, à la résolution choisie) ou « plan à la résolution de
  la photo » (facteur 1 = résolution d'origine ; légende et cartouche ajoutés À CÔTÉ, jamais sur la
  photo) ; PNG transparent pour le plan sans fond.
- Chargés à la demande : fenêtre d'export, jsPDF, polices (mises en cache hors ligne).

### 16.5 Statut « Approuvé »

`setPlanStatus` refuse « Approuvé » sans nom d'approbateur ET confirmation explicite d'autorisation
(boîte dédiée) ; la date est enregistrée ; tout autre statut retire l'approbation ; une copie de plan
redevient « Brouillon ». Aucun code ne l'attribue automatiquement.
