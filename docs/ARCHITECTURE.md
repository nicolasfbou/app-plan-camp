# CampPlanner — Audit technique et proposition d'architecture

> Statut : **architecture approuvée**. Phase 0 (fondations) livrée, voir [`ROADMAP.md`](ROADMAP.md).
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
| Konva             | Stage en 8 couches séparées : fond, zones, bâtiments, circulation, piétons, signalisation, textes, surcouche d'interaction.                                                                                                                   |
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

## 10. Questions ouvertes (à valider avant la phase 0)

1. **Web (navigateur/PWA) ou application installée** (Windows) ? Recommandation : web/PWA d'abord.
2. **Local uniquement en V1** (pas de comptes, pas de serveur) : est-ce acceptable ?
3. **Taille typique de vos photos** (ex. drone 20 MP, orthomosaïque 30 000 px) ? Cela détermine
   si le tuilage est nécessaire dès la V1.
4. **Langue** : interface en français uniquement, ou français et anglais ?
5. Avez-vous une **charte graphique** (logo, couleurs, cartouche client type) à respecter ?
