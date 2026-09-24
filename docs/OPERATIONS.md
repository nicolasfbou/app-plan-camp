# Exploitation — déploiement, sauvegarde, restauration

Procédures de la phase 9.1 pour déployer le serveur CampPlanner de façon reproductible, le
sauvegarder et le restaurer. Tout a été exécuté sur une **infrastructure de test isolée** :
Docker local, PostgreSQL 16 et SeaweedFS jetables. **Rien n'a été fait sur une infrastructure de
production.** Référence technique du serveur : [PHASE9-SERVER.md](PHASE9-SERVER.md).

## 1. Architecture de déploiement

```
Internet ──HTTPS──> Caddy (TLS, HSTS) ──HTTP──> CampPlanner (Node 22, API + application)
                                                  │            │
                                    rôle applicatif │            │ fichiers (photos, PDF,
                                    (RLS appliquée) ▼            ▼ pictogrammes, logos)
                                          PostgreSQL 16      disque (volume) ou S3
```

| Élément                      | Fichier                          | Rôle                                                                                            |
| ---------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------- |
| Image serveur                | `deploy/Dockerfile` (`server`)   | API + application construite ; utilisateur non root (`node`, uid 1000)                          |
| Image d'exploitation         | `deploy/Dockerfile` (`ops`)      | outils PostgreSQL 16 officiels + Node : migrations, sauvegarde, restauration, nettoyage         |
| Pile de référence            | `deploy/docker-compose.yml`      | `db`, `migrate` (étape séparée), `campplanner`, `https` (Caddy), `ops` (à la demande)           |
| HTTPS                        | `deploy/Caddyfile`               | certificat automatique (Let's Encrypt) ou interne (`localhost`), HSTS, redirection HTTP → HTTPS |
| Premier démarrage de la base | `deploy/initdb/10-app-role.sh`   | rôle `campplanner_app` sans droits de propriétaire                                              |
| Secrets locaux               | `deploy/make-secrets.sh`         | génère des secrets aléatoires pour un ESSAI (jamais en production)                              |
| Configuration non secrète    | `deploy/campplanner.env.example` | à copier en `deploy/campplanner.env` (ignoré par Git)                                           |
| Essai de fumée               | `deploy/smoke-test.sh`           | HTTPS, santé, persistance, sauvegarde, restauration isolée (hôte de test)                       |

Azure, qui a la préférence :

- **Base :** Azure Database for PostgreSQL (serveur flexible, version 16).
- **Serveur :** Container Apps ou App Service (conteneur) avec l'image `server`.
- **Fichiers :** stockage compatible S3, ou pilote Azure Blob, qui reste à écrire derrière
  l'interface `ObjectStorage`.
- **Secrets :** Key Vault, montés en fichiers ou en variables.

La même image fonctionne sur un serveur PAMM avec Docker.

## 2. Secrets

- **Aucun secret dans Git ni dans l'image.** `deploy/secrets/`, `deploy/campplanner.env` et
  `deploy/backups/` sont ignorés par Git.
- **Variables `<NOM>_FILE` :** chaque secret peut être lu dans un fichier monté (secrets Docker,
  Key Vault, Kubernetes). Variables concernées : `DATABASE_URL`, `MIGRATION_DATABASE_URL`,
  `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `BOOTSTRAP_PASSWORD`. Une valeur directe ET un
  fichier en même temps sont refusés.
- **Droits des fichiers secrets :** lecture seule, et seulement pour l'utilisateur du conteneur qui
  les lit. PostgreSQL (image officielle) a l'uid 999, CampPlanner l'uid 1000. Avec des droits
  mauvais, l'essai échoue explicitement (constaté et corrigé en phase 9.1).
- **Deux rôles PostgreSQL :**
  - `campplanner_app` sert au serveur. Il n'est pas propriétaire et la RLS s'applique à lui. Le
    serveur refuse de démarrer avec un rôle superutilisateur ou `BYPASSRLS`.
  - Le propriétaire (`MIGRATION_DATABASE_URL`) sert aux migrations, à la sauvegarde et au
    nettoyage. Pour la sauvegarde, il doit être superutilisateur ou avoir `BYPASSRLS`, car la RLS
    forcée cacherait des lignes.
- **Réseau d'entreprise avec inspection TLS :** l'autorité de certification est fournie
  uniquement au moment de la construction, jamais copiée dans l'image :
  `docker build --secret id=ca,src=ca.pem …`.

## 3. Installation (hôte de test ou de production)

```sh
cp deploy/campplanner.env.example deploy/campplanner.env    # PUBLIC_ORIGIN, stockage…
sudo ./deploy/make-secrets.sh                               # ESSAI : secrets aléatoires
# Production : fournir deploy/secrets/* depuis le coffre de secrets (mêmes noms, mêmes droits)
export CAMPPLANNER_VERSION=2026.09.1 CAMPPLANNER_DOMAIN=campplanner.example.org
docker compose -f deploy/docker-compose.yml build
docker compose -f deploy/docker-compose.yml up -d            # db → migrate → campplanner → https
# Premier administrateur (mot de passe lu dans l'environnement ou un fichier, jamais en argument)
docker compose -f deploy/docker-compose.yml run --rm -e BOOTSTRAP_PASSWORD_FILE=/run/secrets/… migrate \
  node_modules/.bin/tsx --tsconfig server/tsconfig.json server/scripts/bootstrap.ts \
  --org "PAMM" --slug pamm --email admin@… --name "Administrateur"
```

Si Docker Hub est inaccessible, les images de base se fixent par variables : `NODE_IMAGE`,
`POSTGRES_IMAGE`, `CADDY_IMAGE`, par exemple `mirror.gcr.io/library/postgres:16-bookworm`.

## 4. Santé, redémarrage, arrêt

| Point de contrôle       | Signification                                                                                                                                                             |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/health`       | le processus répond                                                                                                                                                       |
| `GET /api/health/ready` | base joignable avec le rôle applicatif ET stockage joignable : `200 {ok, database, storage}`, sinon `503`. Utilisé par le `HEALTHCHECK` de l'image et par l'orchestrateur |

- `restart: unless-stopped` relance automatiquement le serveur, la base et Caddy.
- L'arrêt est propre (`SIGTERM`) : les requêtes en cours se terminent, puis les connexions sont
  fermées.
- Un redémarrage ne perd rien : base et fichiers sont sur des volumes. C'est vérifié par l'essai de
  fumée, qui compare la photo après redémarrage (même SHA-256).

## 5. Mise à jour et retour arrière

**Mise à jour** vers la version `N+1` :

1. **Sauvegarde complète** (§ 6), avant tout.
2. Construire ou récupérer l'image `N+1` : `CAMPPLANNER_VERSION=N+1 docker compose … build`.
3. **Migrations**, étape séparée, avec le rôle propriétaire :
   `CAMPPLANNER_VERSION=N+1 docker compose … run --rm migrate`.
4. Remplacer le serveur : `CAMPPLANNER_VERSION=N+1 docker compose … up -d --no-deps campplanner`.
5. Vérifier `GET /api/health/ready`, une connexion et l'ouverture d'un plan.

**Retour arrière :**

- **Sans changement de schéma :** relancer l'image `N`, soit
  `CAMPPLANNER_VERSION=N docker compose … up -d --no-deps campplanner`.
- **Avec migration :** les migrations ne sont PAS réversibles. On restaure la sauvegarde
  d'avant la mise à jour dans une base vide (§ 7), on bascule la configuration vers cette base,
  puis on relance l'image `N`.
- **Ce que voient les appareils après une restauration :**
  - La restauration renouvelle la **génération** du serveur (`server_meta.generation`).
  - Chaque appareil qui la voit changer relit tout depuis le début.
  - Un plan identique des deux côtés est simplement relié.
  - Un plan qui diffère (version locale plus récente, faite depuis la sauvegarde, ou l'inverse)
    devient un **conflit à décider**.
  - Un plan inconnu du serveur restauré devient un conflit « supprimé ».
  - Rien n'est écrasé en silence, dans aucun sens. Test : `server/test/sync.test.ts`, « serveur
    restauré ».

Ce parcours a été exécuté sur la pile de test : mise à jour `9.1-test` → `9.1-test-b` puis retour,
serveur sain aux deux étapes, photo intacte. Journal : `local-test-data/phase9.1/`.

## 6. Sauvegarde complète

Une sauvegarde de la base sans les fichiers n'est jamais produite.

```sh
docker compose -f deploy/docker-compose.yml --profile ops run --rm ops \
  server/scripts/backup.ts backup --out /backups/2026-09-24
docker compose -f deploy/docker-compose.yml --profile ops run --rm ops \
  server/scripts/backup.ts verify --from /backups/2026-09-24
# (hors Docker : npm run server:backup -- backup --out …, avec pg_dump 16 dans PG_BIN)
```

Contenu du dossier :

- `database.dump` : `pg_dump` au format « custom », pris dans un **instantané exporté**. Il contient
  les comptes (mots de passe hachés), les organisations, les camps, les plans, tout l'historique
  des versions, les révisions et leurs instantanés, les approbations et l'audit.
- `files/<organisation>/<sha256>` : chaque photo, PDF d'origine, page rastérisée, pictogramme et
  logo de modèle. Chacun est **relu depuis le stockage** (disque ou S3) et vérifié par SHA-256 et
  par sa taille. Un fichier absent ou altéré fait échouer la sauvegarde : jamais de sauvegarde
  incomplète présentée comme valide.
- `manifest.json` : migrations appliquées, comptes par table, empreintes de contenu (révisions,
  sceaux, chaînage, approbations ; versions des plans ; audit ; comptes), SHA-256 de l'export et
  de chaque fichier.

La liste des fichiers est lue dans le **même instantané** que l'export : la base et les fichiers
sauvegardés sont cohérents entre eux.

Recommandations :

- une sauvegarde par jour, conservée hors de l'hôte (autre site ou autre compte cloud) ;
- une vérification (`verify`) après chaque sauvegarde ;
- un essai de restauration par trimestre sur une infrastructure isolée (§ 7).

Si le stockage est S3 avec versionnement, cela ne remplace pas la sauvegarde : c'est le couple
base + fichiers qui doit être restaurable ensemble.

## 7. Restauration (infrastructure de test isolée)

```sh
# Pile vide et séparée (autre projet compose = autres volumes ; la production n'est pas touchée)
docker compose -p campplanner-restauration -f deploy/docker-compose.yml up -d db
docker compose -p campplanner-restauration -f deploy/docker-compose.yml --profile ops run --rm \
  -v "$PWD/deploy/backups:/backups" ops server/scripts/backup.ts restore --from /backups/2026-09-24
docker compose -p campplanner-restauration -f deploy/docker-compose.yml up -d campplanner https
```

La restauration :

- **refuse** une base non vide : aucune donnée n'est jamais écrasée ;
- exige que le rôle `campplanner_app` existe sur le serveur cible ;
- vérifie la sauvegarde avant de commencer ;
- restaure la base (`pg_restore`), puis dépose les fichiers dans le stockage cible, qui peut être
  un autre pilote (disque vers S3 ou l'inverse) ;
- **vérifie ensuite** : comptes par table, empreintes de contenu, et chaque fichier relu depuis le
  stockage cible et comparé par SHA-256.

Tout écart est listé et le code de sortie est non nul.

Vérifications faites en phase 9.1 (tests automatiques et essai Docker) :

- comptes, organisations, camps, plans et versions ;
- révisions : sceaux et chaînage ;
- approbation authentifiée : compte, date serveur, commentaire ;
- journal d'audit ;
- SHA-256 de la photo, du PDF, du pictogramme et du logo ;
- connexion avec les mots de passe d'origine ;
- isolation entre organisations toujours active ;
- révision approuvée toujours immuable.

Détails au § 9.

## 8. Test d'intégration S3

Service isolé, ici SeaweedFS : un binaire, sans Docker Hub. MinIO ou Ceph conviennent aussi.

```sh
cat > s3.json <<'JSON'
{"identities":[{"name":"campplanner","credentials":[{"accessKey":"cp_test_access","secretKey":"cp_test_secret_0123456789"}],"actions":["Admin","Read","Write","List","Tagging"]}]}
JSON
weed server -dir=/tmp/weed -ip=127.0.0.1 -filer -s3 -s3.port=8333 -s3.config=s3.json &
S3_TEST_ENDPOINT=http://127.0.0.1:8333 AWS_ACCESS_KEY_ID=cp_test_access \
AWS_SECRET_ACCESS_KEY=cp_test_secret_0123456789 npm run test:s3
```

- Sans `S3_TEST_ENDPOINT`, les tests sont **ignorés** et signalés comme tels, jamais comptés réussis.
- Chaque exécution crée son propre compartiment et le vide à la fin.
- Les mêmes variables activent le test de restauration vers S3 (`server/test/backup.test.ts`).

Configuration du serveur en S3 :

```
STORAGE_DRIVER=s3
S3_BUCKET=…
S3_REGION=…
S3_ENDPOINT=…              # à omettre pour AWS
S3_FORCE_PATH_STYLE=true   # MinIO, SeaweedFS, Ceph
AWS_ACCESS_KEY_ID(_FILE)=…
AWS_SECRET_ACCESS_KEY(_FILE)=…
```

À savoir sur le pilote S3 :

- Les sommes de contrôle du SDK ne sont envoyées que si le service les exige. Sinon, certains
  services compatibles stockaient le découpage « aws-chunked » dans l'objet : défaut réel trouvé
  par ce test et corrigé.
- La taille de chaque objet est relue après écriture ; un objet altéré est retiré et l'envoi
  refusé.

## 9. Nettoyage des fichiers jamais référencés

```sh
docker compose … --profile ops run --rm ops server/scripts/purge-files.ts --dry-run
docker compose … --profile ops run --rm ops server/scripts/purge-files.ts --grace-hours 24
```

Ne supprime **que** les fichiers qu'aucun plan, révision ni modèle n'a jamais cités, par exemple
un envoi abandonné, et seulement après le délai de grâce. Les références s'accumulent sur tout
l'historique : un fichier cité par une ancienne version ou par un plan supprimé (logiquement,
donc restaurable) est protégé. Chaque suppression est inscrite au journal d'audit
(`file.purge`). Ne pas lancer pendant une sauvegarde.

## 10. Ce qui n'a PAS été fait

- Aucun déploiement sur une infrastructure de production, Azure compris.
- Aucun certificat public : essai HTTPS avec le certificat interne de Caddy (`localhost`).
- Pilote Azure Blob non écrit. S3 testé avec SeaweedFS, pas avec AWS S3 ni Azure.
- Pas de réplication PostgreSQL ni de haute disponibilité : le déploiement de référence tient sur
  un hôte.
- Sauvegardes non chiffrées par l'outil : chiffrer le support de destination (disque ou
  compartiment chiffré, accès restreint).
