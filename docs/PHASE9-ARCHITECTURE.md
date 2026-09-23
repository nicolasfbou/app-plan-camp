# Phase 9 — Proposition d'architecture : serveur, comptes et synchronisation

> **Statut : PROPOSITION, à valider avant l'implémentation majeure.** Rien de ce document
> n'est encore codé. Il part de `docs/SERVER-BOUNDARIES.md` (phase 8) et de l'architecture
> locale existante (`docs/ARCHITECTURE.md` §14 à §19), qu'il ne remplace pas.

## 0. Résumé en une page

- **Local-first + serveur central.** IndexedDB reste la base de travail de l'éditeur : chaque
  geste terminé est écrit localement (principe actuel : écriture en fin de geste + journal de
  récupération), jamais envoyé mouvement par mouvement au serveur. Un **moteur de
  synchronisation** séparé envoie ensuite, en arrière-plan, l'état enregistré localement.
  Sans Internet, tout ce qui est déjà sur l'appareil s'ouvre, se modifie, s'exporte.
- **Serveur Node.js + TypeScript (Fastify) + PostgreSQL + stockage objet compatible S3**, dans
  le même dépôt (`server/`). Avantage décisif : le serveur réutilise **le même code de domaine**
  que le client (schémas zod, migrations de documents, calcul d'empreinte et de sceau des
  révisions) — il vérifie donc réellement ce que le client envoie.
- **Unité de synchronisation = le document de plan entier** (pas objet par objet), avec une
  **version serveur** et une concurrence optimiste (`If-Match`). Conflit → jamais de gagnant
  silencieux : dialogue avec ma version / version serveur / auteur / date / changements (moteur
  de comparaison de la phase 7), et historique serveur de TOUTES les versions.
- **Isolation par organisation** : `organization_id` sur chaque table, dérivé de la session
  (jamais du client), clés étrangères composites, et sécurité au niveau des lignes (RLS)
  PostgreSQL en deuxième barrière.
- **Révisions immuables côté serveur** (API + déclencheur SQL). **Approbation réelle** :
  utilisateur authentifié + rôle vérifié + **date du serveur**, sceau recalculé par le serveur,
  entrée d'audit dans la même transaction.
- **Rien de la phase 8 n'est retiré** : IndexedDB, journal de récupération, copies `.campplan`,
  copie de secours, santé du projet restent. Le serveur est une couche de protection en plus.

## 1. Contraintes vérifiées dans le code existant

| Existant (phase 1–8)                                                                                               | Conséquence pour la phase 9                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ProjectRepository` (IndexedDB) : seul point d'accès aux données                                                   | Conservé tel quel. Le moteur de synchro l'utilise ; l'éditeur ne parle JAMAIS au réseau.                                                                                             |
| Identifiants locaux `nanoid(12)` (camps, plans, révisions, objets)                                                 | Gardés comme identifiants serveur, avec clé `(organization_id, id)` : aucune renumérotation, aucun lien cassé.                                                                       |
| Plans versionnés localement (`version`, `PlanConflictError`)                                                       | La version **locale** reste (onglets) ; une **version serveur** distincte s'ajoute (`serverVersion`).                                                                                |
| Fichiers dédupliqués par SHA-256 ; `.campplan` résout les fichiers par SHA                                         | Le serveur identifie un fichier par `(organisation, sha256)`. À la réception d'un plan, l'appareil fait correspondre les fichiers par SHA (même mécanisme que l'import `.campplan`). |
| Révisions : instantané JSON exact + SHA + sceau ; `blobMap` par appareil                                           | Envoyées telles quelles ; le serveur revérifie SHA et sceau avant d'accepter.                                                                                                        |
| Approbation déclarative (nom en texte) ; champs `approverUserId`, `authorUserId`, `statusLog[].userId` déjà prévus | Remplis par le serveur à partir de la session. Le **nom figé** reste dans la révision (historique lisible même si le compte change).                                                 |
| Écriture en fin de geste (≈1,5 s) + journal synchrone                                                              | Inchangé. La synchro envoie l'état **enregistré**, jamais un geste en cours.                                                                                                         |
| Verrou d'édition entre onglets (Web Locks)                                                                         | Inchangé ; un seul onglet par navigateur pousse les changements d'un plan (celui qui détient le verrou), un seul onglet exécute la file de synchro (verrou `campplanner-sync`).      |
| `.campplan` autonome                                                                                               | Inchangé et jamais dépendant du serveur (aucun identifiant serveur obligatoire dedans).                                                                                              |

## 2. Choix du backend (comparaison rapide)

| Option                                                           | Pour                                                                                                                                                                      | Contre                                                                                                                                                        |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Node + TypeScript (Fastify), PostgreSQL, S3-compatible** ✅ | Même langage et **même code de domaine** que le client (validation, migrations, sceaux) ; peu de dépendances ; tests en processus ; déployable sur une VM ou un conteneur | Authentification et audit à écrire nous-mêmes (volume modéré)                                                                                                 |
| B. Supabase (Postgres + Auth + Storage + RLS)                    | Beaucoup fourni « clé en main »                                                                                                                                           | Logique métier en RLS/SQL ou en fonctions Deno (validation du domaine dupliquée ou absente), dépendance à un fournisseur, tests locaux lourds (Docker requis) |
| C. Django / .NET                                                 | Écosystèmes éprouvés                                                                                                                                                      | Deuxième langage : toute la validation (documents, sceaux) serait réécrite et pourrait diverger                                                               |

**Recommandation : A.** Détails :

- `server/` : Fastify 5, `pg` (SQL explicite, pas d'ORM lourd), migrations SQL versionnées
  (`server/migrations/NNN_nom.sql`, appliquées au démarrage dans une transaction, table
  `schema_migrations`), zod pour chaque entrée d'API.
- Code partagé : `src/domain/**` (pur, sans navigateur) importé par le serveur.
- Même origine en production (`/api/*` derrière le même hôte que l'application) → cookies de
  session `HttpOnly; Secure; SameSite=Strict`, pas de CORS ouvert.
- Tests : PostgreSQL **réel** (instance temporaire créée par les tests — disponible dans cet
  environnement), stockage objet sur disque pour les tests, `fastify.inject` pour l'API,
  Playwright pour le parcours complet (mode hors ligne simulé par `context.setOffline`).
- Livraison : `docker-compose.yml` (app + Postgres + MinIO) fourni pour l'hébergement
  (Docker n'est pas disponible dans cet environnement de développement : non exécuté ici).

## 3. Schéma de données (PostgreSQL)

Toutes les tables métier portent `organization_id` ; les clés sont composites
`(organization_id, id)` et les clés étrangères aussi → une ligne ne peut PAS référencer une
ligne d'une autre organisation, même par erreur de code.

```
organizations(id uuid PK, name, slug unique, settings jsonb, created_at)

users(id uuid PK, email citext unique, display_name, password_hash,   -- argon2id
      status 'active'|'disabled', created_at, disabled_at)

memberships(organization_id FK, user_id FK, role 'admin'|'manager'|'editor'|'reader',
            created_at, PK(organization_id, user_id))

camp_access(organization_id, camp_id, user_id, PK(...))             -- facultatif (§6)

sessions(id_hash PK, user_id, organization_id, created_at, expires_at, last_seen_at,
         user_agent_hash)                                           -- jeton opaque, stocké haché

camps(organization_id, id text, name, notes, created_by, created_at, updated_at,
      deleted_at null, server_version bigint, PK(organization_id, id))

plans(organization_id, id text, camp_id, name, kind, status,
      created_by, updated_by, created_at, updated_at, deleted_at null,
      server_version bigint not null,          -- concurrence optimiste
      current_version_id, PK(organization_id, id),
      FK(organization_id, camp_id) → camps)

plan_versions(organization_id, plan_id, version bigint, document jsonb,  -- HISTORIQUE COMPLET
              document_sha256, schema_version, author_id, created_at, client_op_id,
              base_version, PK(organization_id, plan_id, version))   -- jamais modifié

revisions(organization_id, id text, plan_id, label, meta jsonb,       -- métadonnées scellées
          snapshot_sha256, seal, status, approved_at, approved_by,
          parent_id, parent_seal,                                     -- chaîne scellée (§10)
          created_by, created_at, deleted_at, PK(organization_id, id))
revision_snapshots(organization_id, revision_id, json text, PK(...))  -- texte EXACT

files(organization_id, sha256 char(64), byte_length, mime_type, storage_key,
      created_by, created_at, PK(organization_id, sha256))           -- dédupliqué par org
file_refs(organization_id, sha256, owner_kind 'plan'|'revision'|'template'|'asset',
          owner_id, PK(...))                                         -- qui utilise quoi

templates(organization_id, id text, name, body jsonb, logo_sha256, created_by,
          updated_at, deleted_at, server_version, PK(organization_id, id))
symbol_assets(organization_id, id text, name, sha256, mime_type, ..., deleted_at)

audit_events(id bigserial PK, organization_id, user_id, action, target_kind, target_id,
             at timestamptz default now(), request_id, context jsonb)  -- ajout seul

change_log(organization_id, seq bigserial, kind, id, server_version, deleted,
           PK(organization_id, seq))                                 -- curseur de synchro
idempotency_keys(organization_id, key text, user_id, response jsonb, created_at,
                 PK(organization_id, key))
```

Garde-fous **en base** (pas seulement dans l'API) :

- `audit_events`, `plan_versions`, `revision_snapshots` : déclencheurs refusant `UPDATE` et
  `DELETE` ; droits `UPDATE/DELETE` retirés au rôle applicatif.
- `revisions` : déclencheur refusant toute modification d'une révision approuvée, sauf le seul
  passage `approved → archived` (l'approbation est conservée), et refusant toute suppression.
- RLS activée sur les tables métier : `USING (organization_id = current_setting('app.org_id'))`,
  positionné par l'API au début de chaque transaction à partir de la session.

## 4. Authentification

- **Phase 9** : comptes locaux au serveur — courriel + mot de passe (argon2id), comptes créés
  par **invitation** d'un administrateur (lien à usage unique, expirant). Pas d'inscription
  libre. Désactivation d'un compte = sessions révoquées immédiatement.
- Sessions : jeton opaque aléatoire (256 bits) en cookie `HttpOnly; Secure; SameSite=Strict`,
  stocké **haché** en base, expiration glissante (ex. 30 jours), protection CSRF par en-tête
  requis (`X-CampPlanner: 1`) + `SameSite`. Limitation des tentatives de connexion.
- Pas de JWT (inutile ici, et une session révocable est préférable).
- **Plus tard (prévu, non développé)** : SSO Microsoft Entra ID / OIDC — l'identité externe se
  rattacherait au même `users.id` (table `user_identities`). Voir question 2.
- **Hors ligne** : une session expirée n'empêche JAMAIS d'ouvrir les plans déjà sur l'appareil ;
  les changements s'accumulent dans la file et partent après reconnexion. L'application
  mémorise l'utilisateur et l'organisation du dernier profil connecté (`localStorage`), sans
  mot de passe.

## 5. Organisations

Organisation (ex. **PAMM**) = utilisateurs (via `memberships`), camps, plans, révisions,
modèles, pictogrammes, paramètres d'entreprise. Un utilisateur peut appartenir à plusieurs
organisations (organisation active choisie à la connexion ; tout changement d'organisation
change la session). **Chaque requête est bornée par l'organisation de la session** ; un
`organizationId` envoyé par le client est ignoré ou refusé s'il diffère.

Côté navigateur : une base IndexedDB **par profil** (`campplanner` = profil local actuel,
`campplanner-<orgId>-<userId>` = données synchronisées d'une organisation), pour qu'aucune
donnée d'une organisation ne se mélange à une autre sur un même poste.

## 6. Rôles et permissions (volontairement simples)

| Action                                                    | Admin |    Gestionnaire     | Éditeur | Lecteur |
| --------------------------------------------------------- | :---: | :-----------------: | :-----: | :-----: |
| Consulter, exporter (PDF, PNG, `.campplan`)               |   ✓   |          ✓          |   ✓*    |   ✓*    |
| Modifier un plan, créer une révision                      |   ✓   |          ✓          |   ✓*    |    —    |
| Créer / renommer / supprimer (soft) camps et plans        |   ✓   |          ✓          |    —    |    —    |
| Changer le statut d'une révision, **approuver**, archiver |   ✓   |          ✓          |    —    |    —    |
| Modèles et pictogrammes d'organisation                    |   ✓   |          ✓          | lecture | lecture |
| Utilisateurs, rôles, paramètres d'organisation            |   ✓   |          —          |    —    |    —    |
| Journal d'audit                                           |   ✓   | lecture (ses camps) |    —    |    —    |

\* Par défaut sur toute l'organisation ; un administrateur peut restreindre un Éditeur ou un
Lecteur à certains camps (`camp_access`). Une seule fonction serveur
`can(user, action, target)` décide ; l'interface masque ce qui est interdit, mais **le serveur
revérifie tout**.

## 7. Fichiers et photos

- Jamais dans la base SQL : stockage objet **compatible S3** (MinIO auto-hébergé, AWS S3,
  Azure Blob via passerelle S3), pilote « disque » pour le développement et les tests.
- Clé : `org/<organizationId>/sha256/<sha256>` → **déduplication par organisation** (pas entre
  organisations : on ne révèle jamais qu'un fichier existe ailleurs).
- Envoi : le client calcule le SHA-256 → `POST /api/files/check` (déjà présent ?) → sinon
  `PUT /api/files/<sha256>` en flux ; le serveur **recalcule le SHA** et refuse s'il diffère,
  vérifie la taille (limite configurable, ex. 200 Mo photo / 2 Mo pictogramme), le type réel
  (octets magiques, pas l'extension), **refuse les SVG dangereux** (script, `foreignObject`,
  gestionnaires `on*`, références externes — même règles que `checkSymbolFile`, revérifiées
  côté serveur). Envoi interrompu → rien n'est enregistré (fichier temporaire supprimé),
  l'envoi reprend depuis le début (idempotent par SHA).
- Lecture : `GET /api/files/<sha256>` uniquement si le fichier est référencé par une ressource
  de l'organisation de la session (sinon 404, identique à « inexistant »).
- `file_refs` : un fichier référencé par une révision n'est jamais supprimé ; nettoyage serveur
  des fichiers sans référence après un délai (même logique que le nettoyage local).

## 8. Synchronisation (local-first)

### 8.1 Côté navigateur

```
Éditeur ──(fin de geste)──> IndexedDB (inchangé) ──> marque le plan « à envoyer »
                                                     │
File de synchro (IndexedDB `outbox`, ordonnée) <─────┘
        │  moteur de synchro (un seul onglet, verrou Web Locks), actif si en ligne + connecté
        ▼
     API serveur  ──>  réponses : nouvelle version | conflit | refus | erreur
```

- Nouvelles tables locales (Dexie v7) : `sync` (lien local ↔ serveur par camp / plan / modèle :
  `organizationId`, `serverVersion` de base, état), `outbox` (opérations), `conflicts`,
  `syncCursor` (dernier `seq` reçu).
- **Opérations** (chacune a un identifiant unique `opId` = clé d'idempotence) :
  `create-camp`, `rename-camp`, `delete-camp`, `upload-file`, `create-plan`, `update-plan`,
  `delete-plan`, `create-revision`, `create-template`, `create-asset`.
  - `update-plan` n'embarque PAS de document figé : au moment de l'envoi, il lit **l'état
    enregistré le plus récent** du plan (les modifications successives hors ligne se regroupent
    en un seul envoi, rien ne se perd, aucune file géante).
  - Ordre garanti par dépendances : fichiers → camp → plan → révisions.
  - **Une opération échouée ne supprime rien** : elle reste en tête avec son erreur visible
    (« Erreur de synchro »), les opérations qui en dépendent attendent, les indépendantes
    continuent. Réessais avec délai croissant pour les erreurs réseau ; les refus (droits,
    validation) demandent une action de l'utilisateur.
- **Approbation et changement de statut : en ligne uniquement** (la date officielle et
  l'autorisation viennent du serveur). Hors ligne, le bouton explique pourquoi.
- **Révision hors ligne** : autorisée (instantané figé localement, statut non approuvé), envoyée
  au retour ; le serveur la revérifie.

### 8.2 Côté serveur

- `PUT /api/plans/:id` avec `If-Match: <serverVersion de base>` et `Idempotency-Key: <opId>` :
  - version égale → nouvelle `plan_versions` + `plans.server_version + 1` + `change_log` +
    audit (si « modification importante », §12), dans UNE transaction ;
  - version différente → **409** avec la version serveur (document, auteur, date) ;
  - même `opId` rejoué → même réponse (aucun double enregistrement).
- `GET /api/sync/changes?since=<seq>` : ce qui a changé dans l'organisation (création,
  modification, suppression logique) depuis le curseur → le client télécharge les documents et
  fichiers manquants (fichiers résolus par SHA : déjà présents localement = pas de
  téléchargement).
- Réception d'un plan modifié ailleurs alors que la copie locale est **propre** : mise à jour
  locale (version locale +1, les onglets en lecture la relisent — mécanisme phase 8). Si la
  copie locale a des changements non envoyés : **conflit**, jamais de remplacement.

### 8.3 Indicateur (toujours visible, barre du haut et liste des plans)

`En ligne · synchronisé` · `Hors ligne` · `Synchronisation…` · `Changements locaux (n)` ·
`Conflit` · `Erreur de synchro` — par plan (liste) et global (barre). Détail au clic :
opérations en attente, dernière synchro réussie, erreurs.

## 9. Conflits

Détectés par la version serveur (jamais par l'heure). Dialogue :

- **Ma version** (appareil, date de la dernière modification locale) / **version serveur**
  (auteur, date serveur, numéro) / **changements concernés** : calculés avec `diffPlans`
  (phase 7) entre la base commune (dernière version serveur connue, conservée localement) et
  chacune des deux versions → « modifié des deux côtés » mis en évidence.
- Choix :
  1. **Conserver ma version comme nouveau brouillon** : envoyée PAR-DESSUS la version serveur
     (`If-Match` = version serveur actuelle, choix explicite) — la version serveur reste dans
     l'historique (`plan_versions`), rien n'est détruit ;
  2. **Utiliser la version serveur** : ma version est d'abord enregistrée comme copie locale
     « (ma version — conflit du …) », puis la version serveur remplace le brouillon local ;
  3. **Créer une copie** : ma version devient un nouveau plan (envoyé), la version serveur reste ;
  4. **Décider plus tard** : le conflit reste ouvert, la copie locale est intacte et
     modifiable, l'envoi de ce plan est suspendu (indicateur « Conflit »).
- Pas de fusion automatique objet par objet en phase 9 (prévue ensuite, la base commune est
  déjà conservée pour la permettre).

## 10. Révisions sur le serveur

- `POST /api/revisions` (idempotent) : métadonnées + instantané exact. Le serveur revérifie :
  schéma, SHA-256 de l'instantané, sceau, appartenance du plan, fichiers référencés présents
  dans l'organisation, statut **non approuvé** (une révision n'arrive jamais « approuvée »).
- **Chaîne scellée** : le serveur ajoute `parent_seal` (sceau de la révision précédente) et un
  sceau de chaîne → comble la limite de la phase 7 (identifiant de la révision précédente hors
  sceau), sans changer le format local.
- Immuabilité : l'API n'offre aucune modification d'instantané ; le déclencheur SQL refuse toute
  modification d'une révision approuvée (même requête directe malveillante, même bug de code).
- Suppression : logique (`deleted_at`) pour les révisions non approuvées ; **jamais** pour une
  révision approuvée.

## 11. Approbation réelle

`POST /api/revisions/:id/approve` (Admin / Gestionnaire, en ligne) :
serveur vérifie session + rôle + organisation + intégrité de l'instantané, puis enregistre dans
UNE transaction : `approved_by = userId` de la session, **nom figé** (`display_name` du compte
à cet instant), **date serveur** (`now()`), commentaire, organisation ; recalcule le sceau
(code de domaine partagé) ; ajoute l'entrée d'audit. Le client reçoit la révision scellée par
le serveur et la stocke telle quelle. Pas de signature cryptographique en phase 9 : identité
authentifiée + audit serveur (conforme à la demande). La case « je confirme être autorisé »
est conservée comme geste explicite.

## 12. Journal d'audit

Écrit **dans la même transaction** que l'action (pas d'action sans trace, pas de trace sans
action). Actions : `camp.create|rename|delete|restore`, `plan.create|update.major|rename|
delete|restore|import|publish`, `revision.create|status|approve|archive|delete`,
`file.upload`, `template.*`, `member.invite|role|disable`, `conflict.resolve`.
Champs : utilisateur, organisation, action, cible, date serveur, identifiant de requête,
contexte minimal (ex. versions avant / après, nombre d'objets modifiés) — **jamais** le
document, la photo ni de données personnelles superflues.
« Modification importante » = une entrée par envoi de plan avec résumé chiffré (pas une par
geste).

## 13. Modèles, pictogrammes, paramètres d'organisation

`templates` et `symbol_assets` deviennent des ressources d'organisation, synchronisées comme
les plans (lecture pour tous les membres, écriture Admin / Gestionnaire). « Envoyer à
l'organisation » depuis la liste des modèles locaux ; les `.campmodele` restent importables et
exportables hors connexion.

## 14. Publication d'un projet local (« Publier dans PAMM »)

1. Vérification (santé du projet phase 8) : plans lisibles, révisions intègres, photo conforme.
2. Calcul des SHA-256, taille totale, nombre de plans / révisions / fichiers.
3. Interrogation du serveur : fichiers déjà présents (non renvoyés), identifiants déjà utilisés
   dans l'organisation (conflit potentiel → proposer « publier comme copie »).
4. Récapitulatif affiché → confirmation → envoi (file de synchro, reprise possible).
5. Après publication : camp et plans **liés** au serveur (table `sync`), mêmes identifiants.

- Révisions déjà « approuvées » localement (approbation déclarative sans compte) : proposition
  — importées comme **« approbation locale déclarée (non vérifiée) »**, immuables, affichées
  distinctement d'une approbation serveur. Voir question 4.
- `.campplan` : « Importer localement » (inchangé) ou « Importer et publier ».

## 15. Suppressions

Suppression **logique** côté serveur (`deleted_at`, restaurable par un Admin / Gestionnaire,
auditée), propagée par le journal des changements (`change_log`). Hors ligne : mise en file
comme les autres opérations. Une révision approuvée n'est jamais supprimée (API + SQL).
Localement, un plan supprimé ailleurs alors qu'il a des changements non envoyés → conflit
« supprimé ailleurs » (mécanisme phase 8 étendu).

## 16. Sécurité (vérifié côté serveur, jamais seulement dans l'interface)

Authentification sur chaque route ; organisation dérivée de la session ; permission par
`can()` ; clés composites + RLS ; appartenance des fichiers ; taille, type réel, SVG ; SHA
recalculé ; accès aux révisions ; approbation (rôle + intégrité) ; limitation de débit sur la
connexion ; en-têtes de sécurité (CSP stricte) ; réponses 404 pour ce qui n'appartient pas à
l'organisation (pas de fuite d'existence). Tests dédiés (§17).

## 17. Plan de tests

- **Sécurité** (API, PostgreSQL réel) : organisation A lit / modifie / télécharge un fichier de
  B ; éditeur approuve ; lecteur modifie ; modification d'une révision approuvée (API ET SQL
  direct) ; SVG dangereux ; envoi surdimensionné ; faux type ; SHA menteur ; faux
  `organizationId` ; faux `userId` dans une approbation ; session révoquée ; CSRF.
- **Synchronisation** : en ligne, hors ligne, retour en ligne, conflit entre deux
  « ordinateurs » (deux profils), serveur indisponible, envoi de photo interrompu, double envoi,
  requête rejouée (idempotence), suppression hors ligne, révision hors ligne, ordre des
  opérations, opération refusée n'effaçant pas les suivantes.
- **Non-régression** : toute la suite phases 1–8 (le mode local sans compte reste identique).
- **Camp 105** (copie du projet) : publier → ouvrir sur un second profil → hors ligne →
  modifier → modifier la version serveur depuis l'autre profil → retour en ligne → conflit
  détecté → conserver les deux versions → créer une révision → vérifier l'audit → SHA-256 de
  la photo identique partout.

## 18. Découpage de l'implémentation

1. `server/` : squelette Fastify, migrations SQL, tests PostgreSQL, organisations, comptes,
   invitations, sessions, rôles, `can()`, RLS, audit.
2. Fichiers (stockage objet, vérifications), camps, plans + historique des versions,
   `change_log`, idempotence.
3. Révisions serveur (vérification, chaîne scellée, immuabilité SQL), approbation réelle.
4. Client : connexion, profils, Dexie v7, file de synchro, moteur, indicateur d'état.
5. Conflits (dialogue + comparaison), suppressions, publication d'un projet local, modèles.
6. Tests sécurité / synchro / e2e, scénario Camp 105, revue indépendante, corrections,
   documentation.

## 19. Ce qui n'est PAS fait en phase 9

Curseurs multi-utilisateurs, édition simultanée temps réel, WebSocket de collaboration,
commentaires en direct, notifications push, application mobile native, fusion automatique
objet par objet, signature cryptographique, SSO (prévu, voir question 2).

## 20. Décisions à confirmer

1. **Pile serveur** : Node + TypeScript (Fastify) + PostgreSQL + stockage S3-compatible
   (recommandé), plutôt que Supabase ou un autre langage.
2. **Connexion** : courriel + mot de passe avec invitations maintenant, SSO Microsoft
   (Entra ID) plus tard — ou SSO dès la phase 9 ?
3. **Hébergement visé** (n'influence pas le code, grâce au stockage S3-compatible) : serveur
   interne PAMM, Azure, AWS ?
4. **Révisions approuvées localement avant la phase 9** : importées comme « approbation locale
   déclarée (non vérifiée) », ou remises au statut précédent pour être ré-approuvées par un
   compte ?
5. **Poste partagé** : les données d'une organisation restent sur l'appareil après
   déconnexion (indispensable pour le hors ligne, recommandé), ou sont effacées à la
   déconnexion ?
