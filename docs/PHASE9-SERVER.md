# Phase 9 — Serveur, comptes et synchronisation

Référence technique de la phase 9 : serveur, schéma PostgreSQL, API, synchronisation et sécurité.
Le document de décision est [PHASE9-ARCHITECTURE.md](PHASE9-ARCHITECTURE.md), approuvé avant
l'implémentation.

**Principe.** L'application reste _local-first_ :

```
geste terminé → enregistrement local → journal de récupération → IndexedDB
              → file de synchronisation → serveur
```

Le serveur est la référence partagée de l'organisation. Il ne remplace ni IndexedDB, ni le
journal de récupération, ni `.campplan`, ni les sauvegardes externes, ni la copie de secours, ni
la santé du projet. Aucun de ces mécanismes n'a été retiré.

Hors périmètre, volontairement :

- collaboration en temps réel, curseurs partagés, WebSockets d'édition ;
- commentaires en direct, notifications push, application mobile native ;
- fusion automatique.

---

## 1. Vue d'ensemble

| Élément       | Choix                                                                                                   |
| ------------- | ------------------------------------------------------------------------------------------------------- |
| Serveur       | Node.js + TypeScript (Fastify 5), lancé par `tsx` (`npm run server`)                                    |
| Base          | PostgreSQL 16, SQL explicite (`pg`), migrations SQL versionnées (`server/migrations`)                   |
| Fichiers      | Interface `ObjectStorage` : disque local (`fs`) ou compatible S3 (`s3`) ; Azure Blob prévu              |
| Mots de passe | argon2id (`@node-rs/argon2`, m = 19 456 Kio, t = 2, p = 1), jamais stockés en clair                     |
| Sessions      | Jeton opaque aléatoire (256 bits) ; seul son SHA-256 est en base ; cookie `HttpOnly`, `SameSite=Strict` |
| Code métier   | Le serveur réutilise `src/domain` (schéma des plans, sceaux des révisions) : une seule vérité           |
| Configuration | Variables d'environnement uniquement (§ 6)                                                              |

Arborescence :

```
server/
  migrations/001_init.sql   schéma, déclencheurs, RLS, droits du rôle applicatif
  src/
    app.ts                  construction de l'application (auth, CSRF, erreurs)
    config.ts               variables d'environnement
    db.ts                   pool + tx(orgId, userId) : fixe app.org_id pour la RLS
    permissions.ts          rôles → actions (une seule matrice)
    auth/                   mots de passe (argon2id), sessions, limitation des tentatives
    routes/                 auth, members (+ invitations, audit), camps, plans, revisions,
                            files, templates, sync
    storage/                ObjectStorage : fsStorage, s3Storage
    files/validate.ts       type réel (octets magiques), SVG dangereux
    documents.ts            validation d'un document de plan (schéma client), SHA référencés
  scripts/bootstrap.ts      première organisation + premier administrateur
  scripts/e2e-server.ts     serveur jetable (PostgreSQL temporaire) pour e2e et démonstration
  test/                     tests serveur (PostgreSQL réel temporaire)
src/sync/                   client : file, moteur, dépôt synchronisé, publication, interface
src/account/                client : connexion, invitation, espace, organisation, verrouillage
```

## 2. Schéma PostgreSQL

Le fichier complet est `server/migrations/001_init.sql`.

### Identité (hors RLS, toujours filtrée par la session)

| Table             | Rôle                                                                                                                        |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `organizations`   | organisation (nom, identifiant court)                                                                                       |
| `users`           | personne : courriel unique, nom affiché, statut `active` ou `disabled`                                                      |
| `user_identities` | moyens de connexion du **même** compte : `password` (argon2id) aujourd'hui, `oidc` (Entra ID : `issuer\|subject`) plus tard |
| `memberships`     | appartenance (organisation, utilisateur, rôle, statut)                                                                      |
| `invitations`     | invitation par un administrateur ; seul le SHA-256 du jeton est stocké ; expiration ; usage unique                          |
| `sessions`        | SHA-256 du jeton, organisation, `device_mode` (`trusted` ou `shared`), expiration, révocation                               |

`user_identities` prépare Microsoft Entra ID. Une identité externe sera **rattachée** à un
utilisateur existant, sans créer un second compte. L'index unique `(provider, subject)`
l'empêche d'appartenir à deux comptes.

### Données métier (RLS forcée, clés composites `(organization_id, id)`)

| Table                | Rôle                                                                                                                                                                                    |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `camps`              | camps ; suppression logique ; `server_version`                                                                                                                                          |
| `plans`              | en-tête du plan (nom, type, statut, camp) ; `server_version` ; suppression logique                                                                                                      |
| `plan_versions`      | **historique complet** des documents (ajout seul) : chaque version reçue, auteur, SHA                                                                                                   |
| `revisions`          | métadonnées (`meta json`, texte conservé à l'identique pour le sceau), statut, `verification_type`, `approved_at` (date serveur), `approved_by`, chaînage (`parent_seal`, `chain_hash`) |
| `revision_snapshots` | instantané figé de la révision (ajout seul)                                                                                                                                             |
| `files`              | fichiers de l'organisation identifiés par SHA-256 (taille, type réel, clé de stockage)                                                                                                  |
| `file_refs`          | qui référence quel fichier (plan, révision, modèle)                                                                                                                                     |
| `templates`          | modèles de l'organisation                                                                                                                                                               |
| `camp_access`        | restriction facultative d'un camp à certains utilisateurs                                                                                                                               |
| `change_log`         | curseur de synchronisation (ajout seul)                                                                                                                                                 |
| `idempotency_keys`   | réponses mémorisées des opérations rejouées                                                                                                                                             |
| `audit_events`       | journal d'audit (ajout seul)                                                                                                                                                            |

### Garde-fous en base (valables même si l'API avait un défaut)

- **Isolation (RLS).**
  - `ENABLE` + `FORCE ROW LEVEL SECURITY` sur les 12 tables métier.
  - Politique `organization_id = current_org()`.
  - `current_org()` lit `app.org_id`, que `tx()` fixe au début de chaque transaction **depuis la
    session**. Sans ce réglage, aucune ligne n'est visible.
- **Rôle applicatif `campplanner_app`.**
  - Il n'est pas propriétaire du schéma, donc la RLS s'applique à lui.
  - Aucun `UPDATE` sur `audit_events`, `plan_versions`, `revision_snapshots` ou `change_log`.
  - `DELETE` seulement sur `sessions`, `idempotency_keys`, `file_refs` et `camp_access`.
- **Ajout seul.** Un déclencheur refuse `UPDATE` et `DELETE` sur l'audit, l'historique des
  plans, les instantanés et le journal des changements, **même pour le propriétaire**.
- **Révisions (`guard_revision`).**
  - Instantané, SHA, libellé, auteur, date et chaînage sont figés.
  - Une révision approuvée ne change plus, sauf « approuvée → archivée », qui conserve
    l'approbation.
  - Elle n'est jamais supprimée, ni physiquement ni logiquement.

## 3. Comptes, rôles, appareils

### Connexion

- Courriel, mot de passe et **type d'appareil obligatoire**. Aucune valeur n'est présélectionnée.
- Pas d'inscription libre : l'accès passe par une invitation d'un administrateur.
- Un échec donne la même réponse pour un compte inconnu et pour un mauvais mot de passe. Un
  calcul argon2 factice égalise le temps de réponse.
- Limitation des tentatives, sur 15 minutes :
  - 8 échecs pour un même compte depuis une même adresse ;
  - 30 pour un même compte, toutes adresses confondues ;
  - 50 pour une même adresse.
    Le titulaire d'un compte attaqué depuis ailleurs peut donc encore se connecter. Derrière un
    proxy, `TRUST_PROXY=true` est indispensable pour voir la vraie adresse.
- Invitation d'un compte existant : même limitation, et l'invitation est **annulée** après 5 mots
  de passe faux. Elle ne peut pas servir à deviner le mot de passe d'un compte d'une autre
  organisation.
- Mot de passe : 12 caractères minimum.
- Plusieurs organisations : la réponse `409 choose-organization` propose la liste, puis
  l'utilisateur choisit.

### Protection des requêtes

- Cookie `cp_session` : `HttpOnly`, `SameSite=Strict`, `Path=/api`, `Secure` en production.
- Toute requête qui modifie exige l'en-tête `X-CampPlanner: 1`. Un formulaire tiers ne peut pas
  l'ajouter : c'est la protection anti-CSRF.

### Rôles (`server/src/permissions.ts`)

| Action                                                                 | Lecteur | Éditeur | Gestionnaire | Admin |
| ---------------------------------------------------------------------- | :-----: | :-----: | :----------: | :---: |
| Consulter                                                              |    ✓    |    ✓    |      ✓       |   ✓   |
| Modifier un plan existant, créer une révision                          |         |    ✓    |      ✓       |   ✓   |
| Créer ou supprimer camps et plans, modèles, publier                    |         |         |      ✓       |   ✓   |
| Changer un statut, **approuver**, supprimer une révision non approuvée |         |         |      ✓       |   ✓   |
| Journal d'audit                                                        |         |         |      ✓       |   ✓   |
| Membres, invitations, rôles                                            |         |         |   lecture    |   ✓   |

L'interface masque ce qui est interdit, mais **le serveur revérifie tout**. Suspendre un membre
révoque ses sessions. Le dernier administrateur est protégé.

Un éditeur ne dépose une révision que **telle que créée** : un seul statut initial, aucune
approbation. Un historique plus riche (statuts successifs, approbation locale déclarée) n'est
accepté que d'un rôle autorisé à publier, et reste « non vérifié ».

Un utilisateur limité à certains camps (`camp_access`) ne lit que les fichiers d'un plan ou d'une
révision de ces camps, ou d'un modèle de l'organisation.

### Type d'appareil

La question est posée à chaque connexion. Le poste n'est jamais supposé personnel.

- **Poste de confiance.**
  - Base IndexedDB propre au profil (`campplanner-<org>-<user>`), travail hors ligne complet.
  - La file de synchronisation est conservée.
  - Avertissement explicite : des données de l'organisation restent sur l'appareil.
  - Session de 30 jours.
- **Poste partagé.**
  - Cookie de session non persistant, durée de 12 heures.
  - Déverrouillage limité à l'onglet (`sessionStorage`). Un nouvel onglet ou un redémarrage
    affiche l'écran verrouillé, sans aucun projet visible, jusqu'à une nouvelle connexion.
  - À la déconnexion :
    - la session est révoquée sur le serveur et le cookie supprimé ;
    - la base du profil est **détruite** ;
    - les journaux de récupération de l'espace sont effacés ;
    - le profil est retiré.
  - Les changements non envoyés sont signalés **avant** : l'utilisateur décide de les envoyer,
    de les exporter (`.campplan`) ou de les abandonner explicitement.
  - Navigateur fermé sans déconnexion : écran verrouillé ; le bouton « Effacer les données de
    cet espace sur ce poste » fonctionne sans session.
  - Serveur injoignable au moment de la déconnexion : la déconnexion est **suspendue**, car la
    session resterait valable sur le serveur. Effacer quand même demande un second choix
    explicite.
  - Autres onglets du même espace : ils ferment la base pour de bon et se rechargent. Une base
    recréée par une écriture tardive est effacée de nouveau au démarrage suivant, grâce à la
    liste des bases purgées.
  - Aucune sauvegarde externe automatique sur un poste partagé : des copies hors du navigateur
    survivraient à la purge.

L'espace **« Local (sans compte) »** des phases 1 à 8 reste intact : base `campplanner`, sans
serveur.

### Révocation d'accès et données déjà sur un appareil (phase 9.1)

Révoquer un accès coupe immédiatement le **serveur** :

- toutes les sessions sont fermées, et les nouvelles requêtes sont refusées même depuis un autre
  navigateur ;
- chaque requête revérifie le compte actif, l'adhésion active et la période d'accès.

Cela n'efface **pas à distance** les données déjà présentes sur un appareil : un appareil
hors ligne ne peut rien recevoir, et CampPlanner ne prétend pas le contraire.

**Périodes d'accès.** Chaque suspension d'un membre ouvre une nouvelle période
(`memberships.access_epoch`).

- Une session n'est valable que dans la période où elle a été ouverte.
- Chaque modification locale mise en file retient la période dans laquelle elle a été faite.
- Le serveur refuse (`409 access-revoked-operation`) toute opération d'une période révoquée, même
  envoyée plus tard avec une nouvelle session valide, après réactivation.

**Appareil de confiance** :

- Le travail hors ligne continue comme prévu.
- Au retour en ligne, la session est revérifiée. Session refusée : rien n'est envoyé, et
  l'indicateur affiche « Connexion requise ».
- Après une nouvelle connexion, les modifications faites dans une période révoquée sont **mises
  en quarantaine** : état « Accès révoqué — modifications non envoyées ». Elles ne sont jamais
  synchronisées automatiquement, et les modifications suivantes du même plan attendent derrière
  elles.
- La personne peut exporter une **copie de secours** (`.campplan`) de ces modifications, puis les
  **mettre de côté**. La version locale est archivée sur l'appareil, la version du serveur est
  reprise, et rien n'est envoyé.

**Appareil partagé** :

- Dès que le serveur refuse la session (expirée, révoquée, compte suspendu), l'espace est
  verrouillé dans l'onglet.
- Déconnexion, et effacement depuis l'écran verrouillé :
  - la base IndexedDB est détruite ;
  - les journaux de récupération sont effacés ;
  - les autres onglets sont fermés, par message entre onglets ET par l'évènement `storage` ;
  - un onglet resté ouvert sans recevoir aucun signal ne peut plus écrire : les écritures
    IndexedDB et les journaux de récupération d'un espace retiré sont refusés ;
  - une base vide rouverte par ce type d'onglet est effacée au démarrage suivant (liste des bases
    purgées, conservée) ;
  - les traces personnelles hors de la base sont effacées : journal d'erreurs, dernier nom
    d'auteur de révision, avertissements de santé ignorés. Le journal est **scellé** (date
    d'effacement) et chaque entrée porte son espace : un onglet figé qui le réécrit avec une vue
    périmée (localStorage est propagé de façon asynchrone entre processus) ne fait réapparaître
    aucune entrée, et ces entrées sont retirées au démarrage suivant.
- Déconnexion hors ligne : suspendue, car la session serveur resterait valable. Si la personne
  choisit « Effacer quand même », la session est fermée sur le serveur dès le retour du réseau
  (le cookie est encore envoyé), sauf nouvelle connexion entre-temps.
- Pas de sauvegarde externe automatique sur un appareil partagé.

**Limites qui restent**, à assumer et à communiquer :

- **Appareil hors ligne** : ses données locales restent lisibles par la personne tant qu'il ne se
  reconnecte pas. C'est vrai pour tout appareil de confiance, et pour un appareil partagé jusqu'à
  la déconnexion ou l'effacement. Aucun effacement à distance n'est possible.
- **Fichiers `.campplan` déjà exportés** (sauvegardes externes, copies de secours, exports) : ce
  sont des fichiers ordinaires, hors du contrôle de CampPlanner. Une révocation ne les atteint
  pas. Ils contiennent le plan, la photo et les révisions. Leur diffusion relève des règles de
  l'organisation : support chiffré, dossiers d'équipe à accès contrôlé, suppression à la fin
  d'une mission.
- **Données non chiffrées** dans le navigateur (IndexedDB) : un accès direct au profil du
  navigateur les montrerait. Protection : chiffrement du disque de l'appareil, session du système
  d'exploitation.
- **Restes hors de CampPlanner** sur un appareil partagé : le cache HTTP du navigateur ne garde
  aucune réponse de l'API (`Cache-Control: no-store`), mais un fichier téléchargé ou exporté
  (dossier « Téléchargements »), l'historique du navigateur (titres et adresses des pages) et
  les mots de passe enregistrés par le navigateur restent sous la responsabilité de la personne
  et de l'administration du poste.
- Un client **modifié** qui ignorerait la période d'accès se heurterait au refus du serveur.
  Seules les modifications ordinaires faites pendant une période **valide** sont acceptées.

## 4. API

Toutes les réponses sont en JSON. Les erreurs ont la forme `{ error, message, …détails }`.
Codes : 401 sans session, 403 rôle insuffisant ou CSRF, 404 introuvable **ou autre
organisation** (même réponse), 409 conflit de version, 413 trop gros, 422 donnée incohérente,
428 `If-Match` manquant.

### Authentification et organisation

| Méthode et route                      | Rôle                                                                                                                                                                                                    |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/auth/login`                | `{ email, password, deviceMode, organization? }` → cookie + `{ user, organization, role, deviceMode, expiresAt }`                                                                                       |
| `GET /api/auth/me`                    | session courante                                                                                                                                                                                        |
| `POST /api/auth/logout`               | révoque la session                                                                                                                                                                                      |
| `GET /api/members`                    | membres (`members.read`)                                                                                                                                                                                |
| `POST /api/invitations`               | `{ email, role }` → lien à usage unique (`members.manage`)                                                                                                                                              |
| `GET /api/invitations/:token`         | aperçu de l'invitation (organisation, courriel, rôle)                                                                                                                                                   |
| `POST /api/invitations/:token/accept` | crée le compte, ou rattache un compte existant après vérification de son mot de passe                                                                                                                   |
| `PATCH /api/members/:userId`          | rôle, suspension ou réactivation (`members.manage`). Une suspension ferme toutes ses sessions et ouvre une nouvelle **période d'accès** (§ 3). Audit : `member.role`, `member.disable`, `member.enable` |
| `GET /api/invitations`                | invitations non acceptées : en attente, expirées, révoquées (`members.manage`)                                                                                                                          |
| `DELETE /api/invitations/:id`         | révocation : le lien est refusé immédiatement (audit `member.invite.revoke`)                                                                                                                            |
| `POST /api/invitations/:id/resend`    | renvoi : l'ancien lien est révoqué, un nouveau jeton est émis (audit `member.invite.resend`)                                                                                                            |
| `GET /api/audit?before=&limit=`       | journal d'audit (`audit.read`)                                                                                                                                                                          |

### Données

Toute écriture accepte `Idempotency-Key: <operationId>`.

| Méthode et route                                         | Rôle                                                                                                                                                                                                        |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/camps`, `PUT/DELETE /api/camps/:id`            | camps (création, renommage, suppression logique)                                                                                                                                                            |
| `GET /api/plans?campId=`                                 | en-têtes des plans                                                                                                                                                                                          |
| `GET /api/plans/:id`                                     | dernier document, `serverVersion`, auteur et date de la dernière modification                                                                                                                               |
| `PUT /api/plans/:id`                                     | enregistre un document. `If-Match: <version>` est obligatoire (`0` pour une création). Réponse 409 `version` ou `deleted` avec la version serveur, son auteur et sa date                                    |
| `DELETE /api/plans/:id` · `POST …/restore`               | suppression logique · restauration                                                                                                                                                                          |
| `GET /api/plans/:id/versions[/:version]`                 | historique complet des versions                                                                                                                                                                             |
| `GET /api/plans/:id/revisions`, `GET /api/revisions/:id` | révisions (avec l'instantané)                                                                                                                                                                               |
| `PUT /api/revisions/:id`                                 | dépôt d'une révision. Le serveur vérifie le SHA de l'instantané, le sceau, les identités (422 `forged-identity`) et refuse une approbation « authentifiée » fabriquée par le client (422 `forged-approval`) |
| `POST /api/revisions/:id/status`                         | changement de statut ou **approbation** : compte connecté, date serveur, audit dans la même transaction                                                                                                     |
| `DELETE /api/revisions/:id`                              | suppression logique d'une révision **non approuvée**                                                                                                                                                        |
| `POST /api/files/check`                                  | quels SHA-256 sont déjà présents                                                                                                                                                                            |
| `PUT /api/files/:sha256`                                 | envoi en flux. Le serveur vérifie la taille, le SHA recalculé, le type réel (octets magiques, `X-File-Type`) et refuse un SVG dangereux. Idempotent                                                         |
| `GET /api/files/:sha256`                                 | lecture, limitée à l'organisation de la session                                                                                                                                                             |
| `GET/PUT/DELETE /api/templates[/:id]`                    | modèles de l'organisation                                                                                                                                                                                   |
| `GET /api/sync/changes?since=&limit=`                    | changements depuis le curseur : `{ changes, cursor, more }`                                                                                                                                                 |
| `POST /api/publish/check`                                | avant publication : identifiants et fichiers déjà présents sur le serveur                                                                                                                                   |
| `GET /api/health`                                        | état du service                                                                                                                                                                                             |
| `GET /api/health/ready`                                  | prêt à servir : base (rôle applicatif) et stockage joignables ; `503` sinon (orchestrateur, voir [OPERATIONS.md](OPERATIONS.md))                                                                            |

L'organisation vient **toujours** de la session. Un `organizationId` ou un `userId` fourni par
le client est ignoré ou refusé. Les tests `security.test.ts` le vérifient.

## 5. Synchronisation

### Unité et opérations

L'unité synchronisée est le **document de plan complet**. Les révisions, fichiers, camps et
modèles ont chacun leurs opérations. Chaque opération de la file (`outbox` dans IndexedDB)
porte :

`operationId`, `entityType`, `entityId`, `organizationId`, `baseServerVersion`, `createdAt`,
`retryCount`, `status` (`pending` ou `failed`), `lastError`, `nextAttemptAt`.

- **Idempotence.**
  - `operationId` est envoyé comme `Idempotency-Key`. Une requête rejouée renvoie la réponse
    mémorisée sans rien refaire : une réponse perdue puis renvoyée ne crée ni deuxième version,
    ni deuxième révision, ni deuxième fichier.
  - Une clé réutilisée pour une autre route ou par un autre utilisateur est refusée (422).
  - Le serveur garde l'empreinte de la requête d'origine (version attendue et corps). Même clé
    avec un **autre contenu** : aucun enregistrement, réponse 422 accompagnée de la réponse
    d'origine. C'est le cas d'une réponse perdue suivie de nouvelles modifications. Le client
    prend alors la version reçue comme base et renvoie le contenu actuel sous une nouvelle clé.
    L'appareil ne croit donc jamais envoyé un contenu que le serveur n'a pas enregistré.
  - Suppression d'un élément dont la création a peut-être atteint le serveur (réponse perdue ou
    envoi en cours) : la suppression est envoyée quand même, après vérification sur le
    serveur.
- **Regroupement.**
  - Plusieurs enregistrements hors ligne du même plan deviennent **une** opération, qui envoie le
    dernier état.
  - Une suppression annule les envois en attente du même plan.
  - Les mouvements de souris ne sont jamais envoyés, seulement les gestes terminés.
- **Ordre.** Les fichiers partent avant le plan qui les référence. Le serveur refuse un plan qui
  référence un fichier absent.
- **Moteur (`SyncEngine`).**
  - Un seul onglet par espace exécute le moteur (Web Lock `campplanner-sync-<espace>`).
  - Cycles : au démarrage, toutes les 20 s, au retour du réseau, peu après chaque écriture
    locale, au retour sur l'onglet.
  - Délai croissant en cas d'échec. Une erreur définitive (403, 422…) est affichée ; seule
    l'utilisatrice ou l'utilisateur décide de réessayer ou d'abandonner. Les opérations
    indépendantes continuent.
- **Réception (`pull`).**
  - Suit `change_log` depuis le curseur. Les inscriptions au journal d'une organisation sont
    sérialisées jusqu'à la validation (verrou transactionnel). L'ordre des numéros est donc
    l'ordre de validation : aucun changement ne peut être sauté par un curseur.
  - Première réception d'un plan : ses révisions sont récupérées aussi, même celles déjà passées
    dans le flux.
  - Camp ou modèle modifié des deux côtés : l'envoi local est refusé et affiché, jamais
    d'écrasement. « Réessayer » envoie quand même, sur la version actuelle du serveur ;
    « Abandonner » reprend immédiatement la version du serveur.
  - Un plan ouvert dans un onglet n'est pas remplacé sous les yeux de la personne : la mise à
    jour est différée et proposée par un bandeau.
  - Un plan avec des changements locaux non envoyés n'est **jamais** écrasé : c'est un conflit.
  - Les références de fichiers (`blobId`) sont rattachées aux fichiers locaux par SHA-256.

### Conflits (aucune fusion automatique, aucun écrasement)

Un envoi avec une `baseServerVersion` périmée reçoit un 409, qui déclenche un conflit enregistré
localement. La fenêtre de conflit montre :

- **Ma version** : date et changements, calculés avec le moteur de comparaison de la phase 7.
- **Version serveur** : numéro, auteur, date et changements.

Choix proposés :

| Choix                                  | Effet                                                                                                    |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Garder la version serveur              | ma version est **mise de côté** sur l'appareil (récupérable), puis remplacée                             |
| Enregistrer ma version comme brouillon | ma version est envoyée **par-dessus**, mais la version serveur reste dans l'historique (`plan_versions`) |
| Créer une copie                        | ma version devient un nouveau plan ; ce plan prend la version serveur ; **les deux restent**             |
| Décider plus tard                      | rien ne change ; l'envoi de ce plan reste suspendu                                                       |

Le cas « supprimé sur le serveur pendant que je modifiais » est traité de la même façon
(`reason: deleted`).

### Révisions et approbations

- Une révision créée hors ligne est envoyée au retour, avec son instantané, son sceau et son
  chaînage vérifiés par le serveur.
- **Approbation.**
  - Seulement en ligne, par un rôle autorisé.
  - Le serveur l'enregistre avec le compte connecté (nom figé), `verificationType:
"authenticated_server"` et la date serveur, dans la même transaction que l'audit.
  - L'interface n'offre ni champ de nom ni champ de date : l'identité est celle du compte.
- **Anciennes approbations locales** (phases 7 et 8).
  - Publiées **telles quelles** : nom déclaré, date historique, commentaire, révision, sceau.
  - Affichées « Approbation locale déclarée — identité non vérifiée »
    (`verificationType: "local_unverified"`, déduit quand le champ est absent).
  - Jamais réécrites ni converties. Elles ne comptent jamais comme une approbation officielle.

### Publication d'un projet local

« Projet local → Publier dans PAMM » :

1. Vérification, puis récapitulatif : camp, plans, révisions, fichiers (nombre, taille, déjà
   présents), SHA-256, approbations locales non vérifiées, conflits d'identifiants possibles,
   problèmes de santé.
2. Confirmation explicite.
3. Le projet est copié dans l'espace de l'organisation via le format `.campplan`, en conservant
   les identifiants. Il est ensuite envoyé par la file ordinaire, donc idempotente et
   reprenable.
4. Le projet local reste intact et marqué « Publié dans PAMM le … ».

`.campplan` reste entièrement indépendant du serveur : export, import et sauvegardes externes
fonctionnent dans tous les espaces.

## 6. Configuration et hébergement

Le serveur se configure uniquement par variables d'environnement. Aucun secret n'a de valeur
par défaut.

| Variable                                                                    | Défaut                   | Rôle                                                                                   |
| --------------------------------------------------------------------------- | ------------------------ | -------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                                              | —                        | connexion du rôle applicatif `campplanner_app`                                         |
| `MIGRATION_DATABASE_URL`                                                    | `DATABASE_URL`           | connexion du propriétaire du schéma (migrations)                                       |
| `HOST`, `PORT`                                                              | `0.0.0.0`, `8787`        | écoute                                                                                 |
| `PUBLIC_ORIGIN`                                                             | `http://localhost:$PORT` | liens d'invitation                                                                     |
| `COOKIE_SECURE`                                                             | `true` en production     | cookie `Secure`                                                                        |
| `TRUST_PROXY`                                                               | `false`                  | derrière un proxy (Azure App Service, passerelle)                                      |
| `SESSION_TTL_DAYS`                                                          | `30`                     | poste de confiance                                                                     |
| `SHARED_SESSION_TTL_HOURS`                                                  | `12`                     | poste partagé                                                                          |
| `MAX_UPLOAD_BYTES`                                                          | 200 Mio                  | taille maximale d'un fichier                                                           |
| `MAX_SVG_BYTES`                                                             | 2 Mio                    | taille maximale d'un SVG                                                               |
| `MAX_PLAN_BYTES`                                                            | 25 Mio                   | taille maximale d'un document de plan                                                  |
| `STATIC_DIR`                                                                | —                        | sert l'application construite (`dist/`) sur la même origine                            |
| `STORAGE_DRIVER`                                                            | `fs`                     | `fs` ou `s3`                                                                           |
| `STORAGE_FS_ROOT`                                                           | `./server-data/files`    | racine du stockage disque                                                              |
| `S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT`, `S3_FORCE_PATH_STYLE`, `S3_PREFIX` | —                        | stockage compatible S3 (AWS, MinIO, Ceph…). Identifiants par la chaîne standard du SDK |

Mise en service :

```sh
# 1. Base : créer la base, le propriétaire et le rôle applicatif (sans droits de propriétaire)
psql -c "CREATE ROLE campplanner_app LOGIN PASSWORD '…'"
# 2. Migrations + première organisation + premier administrateur
MIGRATION_DATABASE_URL=postgres://owner@…/campplanner npm run server:bootstrap -- \
  --org "PAMM" --slug pamm --email admin@… --name "Administrateur"
# 3. Serveur (application servie sur la même origine)
npm run build
DATABASE_URL=postgres://campplanner_app@…/campplanner STATIC_DIR=dist npm run server
```

**Azure** (préféré, non déployé dans cette phase) :

- Azure Database for PostgreSQL (serveur flexible) ;
- App Service ou Container Apps (Node 22) avec `TRUST_PROXY=true` et `COOKIE_SECURE=true` ;
- fichiers : Azure Blob par un pilote `azureBlob` à écrire derrière l'interface `ObjectStorage`
  (4 méthodes : `put`, `get`, `head`, `delete`). Le code métier ne dépend ni d'AWS ni d'Azure.

Le stockage S3 fonctionne aussi avec MinIO sur un serveur PAMM.

## 7. Tests

| Suite                          | Contenu                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `server/test/migrate.test.ts`  | migrations rejouables, schéma                                                                                                                                                                                                                                                                                                                                                                                                  |
| `server/test/auth.test.ts`     | cookie, poste partagé, échecs indiscernables, CSRF, révocation, limitation, invitations, compte existant, suspension                                                                                                                                                                                                                                                                                                           |
| `server/test/plans.test.ts`    | version périmée (409), requête rejouée, création concurrente, suppression logique, `If-Match`                                                                                                                                                                                                                                                                                                                                  |
| `server/test/security.test.ts` | organisation A contre B (lecture, écriture, historique, révisions, fichiers), faux `organizationId`, RLS SQL brute, lecteur, éditeur, faux `userId`, fausse approbation, sceau altéré, approbation immuable, approbation locale publiée, SVG dangereux, envoi surdimensionné, SHA menteur, type déguisé, fichier absent                                                                                                        |
| `server/test/sync.test.ts`     | deux postes simulés (vrai moteur client, fausse IndexedDB, vrai serveur et vraie base) : publication et SHA, hors ligne, conflit (garder la mienne, garder le serveur, copie), serveur indisponible, envoi de photo interrompu, réponse perdue, suppression hors ligne, révision hors ligne, refus serveur ; réponse perdue puis nouvelles modifications, suppression pendant une création en vol, camp renommé des deux côtés |
| `server/test/review.test.ts`   | corrections de la revue indépendante : même clé et autre contenu, journal des changements sans trou, éditeur et révision « approuvée », instantané d'un autre plan, libellés concurrents, invitation et devinette de mot de passe, restriction par camp des fichiers, refus d'un rôle qui contourne la RLS                                                                                                                     |
| `e2e/phase9.spec.ts`           | navigateur réel : type d'appareil obligatoire, hors ligne → en ligne, conflit entre deux ordinateurs, poste partagé (verrouillage, purge), approbation et audit, publication d'un projet local, refus serveur visible                                                                                                                                                                                                          |

Lancement : `npm run test:server`, qui démarre un PostgreSQL temporaire (binaires
`/usr/lib/postgresql/16/bin` ou `PG_BIN`), puis `npx playwright test --project serveur`.

## 8. Limites connues

- **Démarrage** : le serveur refuse un rôle superutilisateur ou `BYPASSRLS` dans
  `DATABASE_URL`. Le propriétaire du schéma ne sert qu'aux migrations
  (`MIGRATION_DATABASE_URL`). La RLS reste la barrière principale : la plupart des requêtes ne
  répètent pas le filtre d'organisation. Le flux des changements et les jointures sensibles le
  font.
- **Nettoyage** : les clés d'idempotence et les invitations expirées restent en base (aucune
  purge planifiée). Les fichiers jamais référencés se nettoient par une commande de maintenance
  ([OPERATIONS.md](OPERATIONS.md) § 9).
- **Invitation** : l'aperçu d'une invitation indique à son détenteur si le courriel correspond à
  un compte existant, pour adapter le formulaire.

- **Microsoft Entra ID** : le modèle d'identité est prêt (`user_identities`), le flux OIDC n'est
  pas écrit.
- **Azure Blob** : l'interface est prête, le pilote n'est pas écrit. Le pilote S3 est testé
  contre un vrai service compatible, SeaweedFS 3.80 isolé (phase 9.1), mais **pas contre AWS S3
  ni Azure**.
- **Docker** : image, `docker compose` et essai de fumée testés localement (phase 9.1). Pas de
  déploiement de production. Voir [OPERATIONS.md](OPERATIONS.md).
- **Révocation hors ligne** : voir « Révocation d'accès et données déjà sur un appareil » (§ 3).
- **Chiffrement** : les données d'un poste de confiance sont stockées en clair dans IndexedDB,
  comme en phase 8. Le poste partagé les détruit à la déconnexion.
- **Session** : une seule session serveur active par navigateur (un seul cookie). Passer d'une
  organisation à l'autre demande une reconnexion ; l'espace local reste accessible hors
  session.
- **Pas de fusion automatique** : un conflit demande toujours une décision humaine.
- **Restauration du serveur** : les droits reviennent à l'état de la sauvegarde. Les suspensions,
  changements de rôle et révocations d'invitations faits après doivent être réappliqués
  ([OPERATIONS.md](OPERATIONS.md) § 7). Toutes les sessions sont fermées par la restauration.
- **Éditeur limité à certains camps** : il ne voit que les fichiers de ses camps, des modèles, et
  ceux qu'il a lui-même envoyés (ou renvoyés à l'identique). Un fichier d'un autre camp est traité
  comme absent, même si son empreinte est connue.
- **Pas de temps réel** : les changements des autres arrivent au prochain cycle (au plus 20 s,
  ou immédiatement au retour sur l'onglet).
- **Poste partagé fermé sans déconnexion** (navigateur fermé de force) : les données restent dans
  IndexedDB, mais **inaccessibles** depuis l'application. L'écran est verrouillé et une nouvelle
  connexion est obligatoire. Sur cet écran, n'importe qui peut choisir « Effacer les données de
  cet espace sur ce poste », sans session. Les changements jamais envoyés sont signalés avant
  l'effacement. Elles ne sont pas chiffrées : un accès direct aux outils du navigateur les
  montrerait jusqu'à l'effacement.
