# Déploiement pilote sur Railway

Guide d'installation, d'exploitation, de sauvegarde et de restauration de CampPlanner sur Railway.
Aucun secret dans ce document ni dans Git : tous les secrets sont saisis dans Railway, en
variables **scellées** (« sealed »).

Tout ce qui est décrit ici a été éprouvé sur une **simulation locale** fidèle
(`deploy/railway-simulation.sh`, voir § 8). Aucune opération n'a encore été faite sur Railway.
Les noms de variables fournis par Railway (compartiments, PostgreSQL) sont à confirmer dans le
tableau de bord au moment de l'installation.

## 1. Architecture

```
navigateur ──HTTPS──▶ bordure Railway (certificat automatique, *.up.railway.app)
                         │
                         ▼
               ┌──────────────────────┐  réseau privé   ┌───────────────────────────┐
               │ campplanner (web)    │ ──────────────▶ │ Postgres (modèle Railway) │
               │ API + application    │                 │ données sur volume        │
               │ AUCUN volume         │                 └───────────────────────────┘
               └──────────┬───────────┘                              ▲
                          │ S3                                        │
                          ▼                                           │
               ┌──────────────────────┐        ┌──────────────────────┴──┐
               │ Bucket « fichiers »  │◀────── │ campplanner-sauvegardes │ tâche planifiée
               │ photos, PDF, pictos  │  lit   │ (image ops, chaque nuit)│ quotidienne
               └──────────────────────┘        └──────────┬──────────────┘
                                                          │ dépose
                                                          ▼
                                               ┌─────────────────────────┐
                                               │ Bucket « sauvegardes »  │
                                               │ base + fichiers, 14 j   │
                                               └─────────────────────────┘
```

| Service Railway           | Rôle                                                                 | Construit depuis                                    | Données durables           |
| ------------------------- | -------------------------------------------------------------------- | --------------------------------------------------- | -------------------------- |
| `campplanner`             | Serveur Node (API) + application React/Vite construite, même origine | `railway.json` → `deploy/Dockerfile`                | aucune (conteneur jetable) |
| `Postgres`                | Modèle PostgreSQL de Railway                                         | image Railway                                       | volume du service          |
| `fichiers` (Bucket)       | Photos aériennes, PDF d'origine, pictogrammes, logos                 | —                                                   | stockage objet Railway     |
| `sauvegardes` (Bucket)    | Sauvegardes complètes quotidiennes                                   | —                                                   | stockage objet Railway     |
| `campplanner-sauvegardes` | Tâche planifiée : sauvegarde complète, rétention                     | `deploy/railway.ops.json` → `deploy/Dockerfile.ops` | aucune                     |

**Aucun fichier important sur le disque d'un conteneur.** Le service web n'a pas de volume. Les
fichiers temporaires (réception d'un envoi, préparation d'une sauvegarde) sont supprimés aussitôt.
Base de données : volume du service Postgres. Fichiers : compartiment S3.

### Compatibilité vérifiée

| Élément                   | Sur Railway                                                                                                                                                                           | Vérification                                                                                                   |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Application React/Vite    | Construite dans l'image, servie par le serveur (même origine, cookies `SameSite=Strict`)                                                                                              | simulation : ouverture, rechargement, 2ᵉ navigateur                                                            |
| Serveur Node.js           | Image `deploy/Dockerfile` (dernière étape = serveur, comme Railway la construit) ; port `PORT` ; contrôle `/api/health/ready`                                                         | simulation                                                                                                     |
| PostgreSQL                | Modèle Railway (superutilisateur `postgres`, **aucun script d'initialisation possible**) : le rôle applicatif est créé par l'étape « avant déploiement » (`npm run server:predeploy`) | `server/test/pilot.test.ts` ; simulation PostgreSQL 17                                                         |
| Photos et fichiers        | Railway Buckets (S3, adressage « virtual-hosted », privés) via le pilote S3 existant                                                                                                  | simulation (service S3 local en « virtual-hosted ») ; **à revérifier sur Railway** (étape 5 des vérifications) |
| Sauvegardes               | Forfait Hobby : aucune sauvegarde fournie par Railway ⇒ tâche planifiée CampPlanner vers un 2ᵉ compartiment                                                                           | `pilot.test.ts` ; simulation (sauvegarde puis restauration sur une autre base et un autre compartiment)        |
| HTTPS                     | Terminé par la bordure Railway (certificat automatique) ; cookies `Secure` ; `TRUST_PROXY=true`                                                                                       | simulation avec une bordure TLS                                                                                |
| Variables d'environnement | Variables Railway, secrets scellés, références `${{Service.VARIABLE}}`                                                                                                                | § 3                                                                                                            |
| Migrations                | `preDeployCommand` : rôle applicatif → migrations → droits → vérification ; en cas d'échec, la nouvelle version n'est pas mise en service                                             | simulation (première installation et redéploiement)                                                            |

La configuration `docker compose` (`deploy/docker-compose.yml`) **n'est pas utilisée** sur Railway :
Railway ne prend ni les secrets en fichiers, ni les scripts d'initialisation de PostgreSQL, ni le
Caddy de la pile. Elle reste valable pour un hébergement sur un serveur à soi.

## 2. Coûts (forfait Hobby, prix publiés, taxes en sus)

Tarifs de Railway au moment de la préparation :

- abonnement Hobby : 5 $ US par mois, qui incluent 5 $ d'utilisation ;
- mémoire : 10 $ par Go et par mois ; processeur : 20 $ par vCPU et par mois ;
- volume : 0,15 $ par Go et par mois ;
- trafic sortant d'un service : 0,05 $ par Go ;
- compartiments : 0,015 $ par Go et par mois, trafic des compartiments gratuit.

Mesures faites pendant la simulation (au repos et sous faible charge) :

- serveur ≈ 110 Mo de mémoire ;
- PostgreSQL ≈ 40 Mo, peut-être plus avec le modèle Railway ;
- processeur quasi nul hors activité ;
- image de 700 Mo.

Estimation pour le pilote (quelques utilisateurs, moins de 1 Go de photos) :

- **utilisation d'environ 3 à 6 $ par mois**, couverte en grande partie par le crédit inclus ;
- **total d'environ 5 à 8 $ US par mois** ;
- l'utilisation réelle s'affiche dans le tableau de bord Railway.

Forfait Pro (20 $ US par mois, 20 $ d'utilisation inclus) : utile seulement pour obtenir en plus
les sauvegardes planifiées du volume PostgreSQL par Railway. Pas nécessaire au pilote : la
sauvegarde CampPlanner couvre la base ET les fichiers.

## 3. Variables

Les noms `Postgres`, `fichiers` et `sauvegardes` sont ceux donnés aux services dans Railway. Les
noms des variables exposées par un compartiment Railway (`BUCKET`, `ENDPOINT`, `REGION`,
`ACCESS_KEY_ID`, `SECRET_ACCESS_KEY`) sont à confirmer dans l'onglet « Variables » du compartiment.

### Service `campplanner` (web)

| Variable                                      | Valeur                                                                                                                 | Secret           |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `PORT`                                        | `8787`                                                                                                                 | non              |
| `PUBLIC_ORIGIN`                               | `https://${{RAILWAY_PUBLIC_DOMAIN}}`                                                                                   | non              |
| `TRUST_PROXY`                                 | `true`                                                                                                                 | non              |
| `COOKIE_SECURE`                               | `true`                                                                                                                 | non              |
| `MIGRATE_ON_START`                            | `false` (les migrations passent par l'étape « avant déploiement »)                                                     | non              |
| `MIGRATION_DATABASE_URL`                      | `${{Postgres.DATABASE_URL}}`                                                                                           | oui (référence)  |
| `APP_DB_PASSWORD`                             | 48 caractères hexadécimaux aléatoires                                                                                  | **oui, scellée** |
| `DATABASE_URL`                                | `postgresql://campplanner_app:${{APP_DB_PASSWORD}}@${{Postgres.PGHOST}}:${{Postgres.PGPORT}}/${{Postgres.PGDATABASE}}` | oui (référence)  |
| `STORAGE_DRIVER`                              | `s3`                                                                                                                   | non              |
| `S3_BUCKET` / `S3_ENDPOINT` / `S3_REGION`     | `${{fichiers.BUCKET}}` / `${{fichiers.ENDPOINT}}` / `${{fichiers.REGION}}`                                             | non              |
| `S3_FORCE_PATH_STYLE`                         | `false`                                                                                                                | non              |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | `${{fichiers.ACCESS_KEY_ID}}` / `${{fichiers.SECRET_ACCESS_KEY}}`                                                      | oui (références) |
| `BOOTSTRAP_EMAIL`, `BOOTSTRAP_NAME`           | première installation seulement                                                                                        | non              |
| `BOOTSTRAP_PASSWORD`                          | première installation seulement : **choisi et saisi par vous**, scellé, **supprimé** après la première connexion       | **oui, scellée** |

`APP_DB_PASSWORD` : chiffres et lettres a–f uniquement (il entre dans une adresse de connexion).
Pour le générer sur votre ordinateur : `openssl rand -hex 24`. Sous Windows PowerShell :
`-join ((1..48) | % { '{0:x}' -f (Get-Random -Max 16) })`. La valeur n'a pas à être retenue.

### Service `campplanner-sauvegardes` (tâche planifiée)

| Variable                                                       | Valeur                                                                                                                                              |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POSTGRES_IMAGE`                                               | `postgres:<version majeure du service Postgres>-bookworm`, ex. `postgres:17-bookworm` (outils `pg_dump` de la même version ; lue à la construction) |
| `MIGRATION_DATABASE_URL`                                       | `${{Postgres.DATABASE_URL}}`                                                                                                                        |
| `STORAGE_DRIVER`, `S3_*`, `AWS_*`                              | mêmes valeurs que le service web (lecture des fichiers à sauvegarder)                                                                               |
| `BACKUP_S3_BUCKET` / `BACKUP_S3_ENDPOINT` / `BACKUP_S3_REGION` | `${{sauvegardes.BUCKET}}` / `${{sauvegardes.ENDPOINT}}` / `${{sauvegardes.REGION}}`                                                                 |
| `BACKUP_S3_ACCESS_KEY_ID` / `BACKUP_S3_SECRET_ACCESS_KEY`      | `${{sauvegardes.ACCESS_KEY_ID}}` / `${{sauvegardes.SECRET_ACCESS_KEY}}`                                                                             |
| `BACKUP_S3_FORCE_PATH_STYLE`                                   | `false`                                                                                                                                             |
| `BACKUP_KEEP`                                                  | `14` (nombre de sauvegardes complètes gardées)                                                                                                      |

## 4. Installation (opérations sur le compte Railway)

1. Forfait Hobby (payant : 5 $ US par mois).
2. Nouveau projet « CampPlanner pilote », région la plus proche (États-Unis, Est).
3. **Postgres** : « + New » → Database → PostgreSQL. Noter sa version majeure (onglet
   Variables ou journal de démarrage).
4. **Deux compartiments** : « + New » → Bucket → `fichiers`, puis `sauvegardes`.
5. **Service web** : « + New » → GitHub Repo → `nicolasfbou/app-plan-camp`.
   - Réglages : branche `claude/zealous-ritchie-mpwkbn` (pas `main`) ; fichier de configuration
     `railway.json`.
   - Variables du § 3, dont `BOOTSTRAP_*`.
   - Réseau : « Generate Domain » (port 8787).
6. **Tâche planifiée** : « + New » → GitHub Repo, même dépôt et même branche.
   - Fichier de configuration : `deploy/railway.ops.json` (planification `0 7 * * *` : 3 h du
     matin, heure de l'Est en été ; 2 h en hiver).
   - Variables du § 3. Pas de domaine public.
7. Premier déploiement. Le journal de l'étape « avant déploiement » doit montrer :
   - « Rôle applicatif campplanner_app : créé » ;
   - les migrations ;
   - « Connexion du serveur vérifiée » ;
   - « Organisation PAMM créée ; administrateur : … ».

   Aucun mot de passe n'apparaît dans ce journal.

8. Première connexion avec l'administrateur, puis **supprimer `BOOTSTRAP_PASSWORD`** (Railway
   redéploie ; la variable n'est plus lue de toute façon dès qu'une organisation existe).
9. Déclencher une première sauvegarde (tâche planifiée → « Run now »). Son journal se termine par
   « Sauvegarde … déposée ».

**Mot de passe de l'administrateur :** CampPlanner n'a pas encore d'écran de changement ni de
réinitialisation de mot de passe. Celui choisi à l'étape 5 est définitif. Conservez-le dans un
gestionnaire de mots de passe.

## 5. Mises à jour

Un envoi sur la branche déployée provoque une nouvelle construction, puis :

1. l'étape « avant déploiement » : rôle, migrations, droits, vérification ;
2. le contrôle de santé ;
3. la bascule.

En cas d'échec d'une étape, l'ancienne version reste en service. Le service web n'ayant pas de
volume, la bascule se fait sans coupure. **Avant une mise à jour qui contient une migration :**
déclencher une sauvegarde (« Run now ») et vérifier qu'elle est complète.

## 6. Sauvegarde et restauration

**Sauvegarde automatique, chaque nuit.** Elle contient la base complète (comptes, organisations,
camps, plans et tout leur historique, révisions, approbations, audit) et **tous** les fichiers.
Elle est vérifiée, puis déposée dans le compartiment `sauvegardes`, le manifeste en dernier : une
sauvegarde interrompue n'est jamais utilisée. Les 14 plus récentes sont gardées. Lister :
`server/scripts/backup-bucket.ts list` (commande de la tâche, ou `railway run` depuis un poste).

**Restaurer** :

1. Créer un **nouveau** service Postgres. On ne restaure jamais par-dessus des données : la
   restauration refuse une base non vide.
2. Sur le service `campplanner-sauvegardes`, pour une exécution ponctuelle :
   - `MIGRATION_DATABASE_URL` pointe vers le nouveau Postgres ;
   - ajouter `APP_DB_PASSWORD` (même valeur que le service web) ;
   - commande de démarrage : `server/scripts/backup-bucket.ts restore` (la plus récente) ou
     `server/scripts/backup-bucket.ts restore --stamp <horodatage>`.

   Le journal doit se terminer par « Vérification : comptes, empreintes de contenu et fichiers
   identiques à la sauvegarde ».

3. Service web : `MIGRATION_DATABASE_URL` et `DATABASE_URL` pointent vers le nouveau Postgres ;
   redéployer.
4. Remettre la commande par défaut de la tâche planifiée.
5. Après une restauration :
   - chacun se reconnecte (toutes les sessions sont fermées) ;
   - chaque appareil relit tout, et une différence devient un conflit à trancher, jamais un
     écrasement ;
   - les suspensions et changements de rôle faits après la sauvegarde sont à réappliquer (voir
     `docs/OPERATIONS.md` § 7).

Les fichiers peuvent être restaurés dans le même compartiment (objets immuables, nommés par leur
empreinte) ou dans un autre.

**Copie hors de Railway (recommandé) :** les sauvegardes restent chez le même hébergeur. Pour se
protéger d'une perte du compte, télécharger de temps en temps une sauvegarde complète du
compartiment `sauvegardes`, ou exporter les projets importants en `.campplan`.

## 7. Limites du pilote

- Une seule instance du serveur (suffisant pour un pilote ; pas de haute disponibilité).
- Adresse `*.up.railway.app` ; un domaine à vous peut être ajouté plus tard.
- La compatibilité S3 des compartiments Railway n'a pas pu être testée avant le déploiement : le
  pilote S3 a été éprouvé contre SeaweedFS en adressage « virtual-hosted ». L'import de la photo
  et la relecture de son SHA-256 (vérifications 5 et 10) la contrôlent sur Railway.
- L'adresse du superutilisateur PostgreSQL est présente dans les variables du service web : elle
  est nécessaire à l'étape « avant déploiement ». Le serveur, lui, refuse de fonctionner avec ce
  rôle et utilise `campplanner_app` (RLS). Pour une production : déplacer les migrations dans un
  service séparé.
- `TRUST_PROXY=true` : l'adresse IP du client est lue dans `X-Forwarded-For`, falsifiable. Seule
  la limite de tentatives par adresse IP en dépend ; les limites par compte restent en vigueur.
- Sessions à durée fixe (30 jours sur un appareil de confiance, 12 h sur un poste partagé), sans
  prolongation automatique. À l'échéance, l'application demande une nouvelle connexion, et les
  modifications en attente partent ensuite (testé).
- Ni changement ni réinitialisation de mot de passe dans l'application (§ 4).
- Pas d'envoi de courriels : les liens d'invitation sont remis par l'administrateur.

## 8. Simulation locale

`deploy/railway-simulation.sh` reproduit l'architecture sans rien toucher sur Railway :

- les deux images, construites comme Railway les construit ;
- PostgreSQL 17 sans script d'initialisation, sur un volume ;
- deux compartiments S3 en adressage « virtual-hosted » ;
- un service web sans volume, derrière une bordure TLS.

Le script enchaîne ensuite :

1. l'étape « avant déploiement » avec le premier administrateur ;
2. les 11 vérifications en navigateur (`bench/pilot-verify.mjs`) ;
3. la destruction du conteneur web et le redémarrage de PostgreSQL, puis la vérification que
   plan, texte et SHA-256 de la photo sont identiques ;
4. la sauvegarde planifiée, puis la restauration sur une autre base et un autre compartiment,
   avec la même vérification ;
5. la fouille des journaux : aucun mot de passe ni aucune clé.

## 9. Vérifications après déploiement

`bench/pilot-verify.mjs` fait, dans deux navigateurs réels, les 11 vérifications demandées :

1. adresse publique ;
2. ouverture de l'application ;
3. connexion ;
4. création d'un camp ;
5. import de la photo aérienne ;
6. édition d'un plan ;
7. enregistrement ;
8. rechargement ;
9. export PDF ;
10. synchronisation ;
11. réouverture depuis un deuxième navigateur.

Il utilise un compte d'essai. Le mot de passe est lu dans l'environnement, jamais affiché, jamais
visible dans une capture. Le camp d'essai est supprimé à la fin.

## 10. Projet de démonstration Camp 105

`bench/pilot-demo.ts` produit une **copie** du projet Camp 105 avec les fonctions de
l'application (import, duplication, export) :

- nom et titre : « EXEMPLE ILLUSTRATIF — À VALIDER SUR LE TERRAIN » ;
- statut « À valider sur le terrain », **jamais « Approuvé »** ;
- aucune révision reprise ;
- aucune échelle ni orientation.

La photo d'origine est seulement lue : son SHA-256 est vérifié avant, après, dans la copie et sur
le serveur. Pour l'importer dans PAMM après la première connexion : page « Camps », bouton
d'import `.campplan`. Ou automatiquement : `PILOT_DEMO=<fichier>` pour `bench/pilot-verify.mjs`
(étape 12, projet conservé).
