# Frontières d'un futur serveur (document de conception — rien n'est construit)

> Phase 8 : ce document **décrit** où un serveur pourrait se brancher plus tard. Il n'existe
> aujourd'hui **ni authentification, ni comptes, ni serveur, ni nuage, ni collaboration en temps
> réel, ni permissions réseau, ni commentaires partagés**. L'application reste 100 % locale.
>
> Aucun « utilisateur global » fictif n'est créé : les noms saisis (auteur, approbateur) sont du
> **texte libre, non vérifié**. Un sceau de révision n'est **pas** une signature.

## 1. Principes

1. **Le fichier local reste la source de vérité** tant qu'aucun serveur n'existe. Toute
   synchronisation future devra pouvoir retomber sur le `.campplan` (export / import) sans perte.
2. **Identités réelles seulement** : les champs `*UserId` ne sont remplis que par un futur
   service d'authentification. Tant qu'il n'existe pas, ils restent **absents** (jamais une valeur
   inventée comme `local-user`).
3. **Le domaine ne connaît pas le réseau** : `src/domain/**` reste pur ; un serveur se branchera
   derrière `ProjectRepository` (même interface, autre implémentation) et un futur `AuthContext`.
4. **Versions optimistes déjà en place** : chaque plan a un numéro de `version` ; `savePlan(doc,
{ expectedVersion })` refuse d'écraser une version plus récente (`PlanConflictError`). C'est le
   même contrat qu'un futur `PUT /plans/:id` avec `If-Match`.

## 2. Entités

| Entité                   | Aujourd'hui (local)                                                                       | Demain (serveur)                                                                               | Champs prêts                                                                                                                    |
| ------------------------ | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| **User**                 | aucune ; noms en texte libre (`author`, `approval.approver`)                              | compte authentifié (OIDC)                                                                      | `authorUserId`, `approval.approverUserId`, `statusLog[].userId` (optionnels, **inclus dans le sceau** lorsqu'ils sont présents) |
| **Organization**         | aucune ; un « camp » (`Site`) n'appartient à personne                                     | propriétaire des camps, gère les membres                                                       | — (à ajouter : `Site.organizationId`)                                                                                           |
| **Project**              | `Site` (camp) + `Plan` (IndexedDB `sites`, `plans`)                                       | ressources serveur ; `Plan.version` → ETag                                                     | `plan.version` (entier croissant)                                                                                               |
| **Revision**             | `revisions` + `revisionSnapshots` ; instantané JSON exact + SHA-256 + sceau               | immuable côté serveur (écriture unique), vérifiée par SHA-256                                  | `snapshot.sha256`, `seal`, `parentId` (hors sceau, voir § 5)                                                                    |
| **Approval**             | `approval { approver, date, comment, recordedAt, revisionAuthor }`, choisie explicitement | acte signé par un utilisateur autorisé (permission `approve`)                                  | `changeRevisionStatus(meta, { to, by, userId?, … })` accepte déjà un `userId` réel                                              |
| **AuditEvent**           | `statusLog` par révision ; journal local des erreurs (non partagé)                        | journal serveur append-only (qui, quoi, quand, empreinte avant / après)                        | `statusLog[] { to, at, by, comment, userId? }`                                                                                  |
| **Permission**           | aucune (quiconque ouvre le navigateur peut tout faire)                                    | rôles par organisation / camp : lecture, édition, révision, approbation, administration        | — (vérifiée côté serveur, jamais seulement dans l'interface)                                                                    |
| **Stockage de fichiers** | `blobs` IndexedDB, dédupliqués par SHA-256 ; révisions → `blobIds`                        | stockage adressé par contenu (clé = SHA-256), URL signées                                      | `baseImage.sha256`, `revisions.blobIds`, `findBlobBySha256`                                                                     |
| **Synchronisation**      | aucune ; copies externes `.campplan` horodatées ; verrou **local** entre onglets          | pousser / tirer par plan avec `expectedVersion` ; conflit → même dialogue que le conflit local | `PlanConflictError`, `ConflictDialog` (recharger / copie / écraser confirmé)                                                    |

## 3. Points d'insertion prévus

- `ProjectRepository` (`src/persistence/ProjectRepository.ts`) : interface unique ; une
  implémentation réseau garderait les mêmes signatures (`openPlan` → `{ doc, version }`,
  `savePlan` → nouvelle version, erreurs typées).
- Approbation : `changeRevisionStatus` / `freezeRevision` reçoivent `userId` / `authorUserId`
  d'un futur `AuthContext` ; l'interface actuelle n'en passe **aucun**.
- Verrou d'édition : `planLock.ts` (Web Locks + BroadcastChannel) ne protège que **ce
  navigateur**. Un serveur remplacerait ce verrou par un bail d'édition (lease) ou par la seule
  détection de conflit par version.
- Copies de secours : `backupService.ts` écrit dans un dossier choisi par l'utilisateur ; un
  stockage serveur serait une destination supplémentaire, pas un remplacement.

## 4. Ce qui ne doit PAS être fait sans serveur

- Créer un utilisateur par défaut ou présenter un nom saisi comme une identité vérifiée.
- Présenter un sceau SHA-256 comme une signature (il détecte une modification accidentelle, pas
  une falsification délibérée : quiconque peut recalculer le sceau).
- Afficher des permissions (« réservé aux approbateurs ») qui ne seraient pas réellement
  appliquées.

## 5. Limites connues à traiter avec le serveur

- Identité : non vérifiée ; approbation = déclaration locale.
- `parentId` (révision précédente) n'est pas dans le sceau : la chaîne des révisions n'est pas
  scellée. Un serveur devrait chaîner les empreintes (`parentSeal`) et horodater côté serveur.
- Le journal des erreurs et l'historique des sauvegardes restent dans le navigateur.
