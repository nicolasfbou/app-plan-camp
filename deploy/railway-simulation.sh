#!/bin/sh
# Simulation LOCALE de l'architecture Railway (hôte de test uniquement ; aucune action sur Railway) :
#   - images construites comme Railway les construit (deploy/Dockerfile SANS --target, dernière
#     étape ; deploy/Dockerfile.ops pour la tâche planifiée) ;
#   - PostgreSQL 17 « géré » : superutilisateur postgres, base « railway », AUCUN script
#     d'initialisation, données sur un volume ;
#   - deux compartiments S3 (fichiers, sauvegardes) en adressage « virtual-hosted » comme Railway
#     Buckets (service local SeaweedFS, S3_TEST_ENDPOINT) ;
#   - service web SANS volume : conteneur jetable, TLS terminé devant lui (Caddy ≈ bordure Railway) ;
#   - étape « avant déploiement » (npm run server:predeploy) avant chaque mise en service.
# Secrets générés à chaque exécution, écrits seulement dans un fichier 0600 du dossier de travail,
# jamais affichés ; les journaux sont ensuite fouillés pour vérifier qu'ils n'y figurent pas.
#
#   S3_ENDPOINT_HOST=s3.pilote.test S3_PORT=8333 PHOTO=… ./deploy/railway-simulation.sh <dossier-sortie>
set -eu
OUT="${1:?dossier de sortie}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PHOTO="${PHOTO:?photo aérienne à importer}"
S3_HOST="${S3_ENDPOINT_HOST:-s3.pilote.test}"
S3_PORT="${S3_PORT:-8333}"
PG_IMAGE="${POSTGRES_IMAGE:-postgres:17-bookworm}"
NODE_IMAGE="${NODE_IMAGE:-node:22-bookworm-slim}"
CADDY_IMAGE="${CADDY_IMAGE:-caddy:2}"
V=railway-sim
WORK="$(mktemp -d)"; chmod 700 "$WORK"
mkdir -p "$OUT"
say() { printf '\n== %s\n' "$*"; }
rnd() { head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'; }
cleanup() {
  docker rm -f cp-sim-web cp-sim-web2 cp-sim-edge cp-sim-pg cp-sim-pg2 >/dev/null 2>&1 || true
  docker volume rm cp-sim-pg cp-sim-pg2 >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT
cleanup; WORK="$(mktemp -d)"; chmod 700 "$WORK"

PG_PW="$(rnd 24)"; APP_PW="$(rnd 24)"; ADMIN_PW="Pilote-$(rnd 12)"
RUN="$(rnd 3)"; FILES="pilote-fichiers-$RUN"; BACKUPS="pilote-sauvegardes-$RUN"; RESTORED_FILES="pilote-restaure-$RUN"
HOSTS="--add-host $S3_HOST:127.0.0.1 --add-host $FILES.$S3_HOST:127.0.0.1 --add-host $BACKUPS.$S3_HOST:127.0.0.1 --add-host $RESTORED_FILES.$S3_HOST:127.0.0.1"
web_env() { # $1 port postgres, $2 compartiment des fichiers
  cat <<EOF
PORT=7311
PUBLIC_ORIGIN=https://localhost:8443
TRUST_PROXY=true
COOKIE_SECURE=true
MIGRATE_ON_START=false
MIGRATION_DATABASE_URL=postgresql://postgres:$PG_PW@127.0.0.1:$1/railway
DATABASE_URL=postgresql://campplanner_app:$APP_PW@127.0.0.1:$1/railway
APP_DB_PASSWORD=$APP_PW
STORAGE_DRIVER=s3
S3_BUCKET=$2
S3_REGION=us-east-1
S3_ENDPOINT=http://$S3_HOST:$S3_PORT
S3_FORCE_PATH_STYLE=false
AWS_ACCESS_KEY_ID=${AWS_ACCESS_KEY_ID:?}
AWS_SECRET_ACCESS_KEY=${AWS_SECRET_ACCESS_KEY:?}
BACKUP_S3_BUCKET=$BACKUPS
BACKUP_S3_REGION=us-east-1
BACKUP_S3_ENDPOINT=http://$S3_HOST:$S3_PORT
BACKUP_S3_FORCE_PATH_STYLE=false
BACKUP_S3_ACCESS_KEY_ID=$AWS_ACCESS_KEY_ID
BACKUP_S3_SECRET_ACCESS_KEY=$AWS_SECRET_ACCESS_KEY
BACKUP_KEEP=14
EOF
}
web_env 55432 "$FILES" > "$WORK/web.env"
{ web_env 55432 "$FILES"; printf 'BOOTSTRAP_EMAIL=admin@pamm.test\nBOOTSTRAP_NAME=Administrateur PAMM\nBOOTSTRAP_PASSWORD=%s\n' "$ADMIN_PW"; } > "$WORK/first.env"
chmod 600 "$WORK"/*.env

say "0. Compartiments S3 (fichiers, sauvegardes, cible de restauration)"
node -e "
const { S3Client, CreateBucketCommand } = require('$ROOT/node_modules/@aws-sdk/client-s3');
const c = new S3Client({ region: 'us-east-1', endpoint: 'http://127.0.0.1:$S3_PORT', forcePathStyle: true });
Promise.all(['$FILES','$BACKUPS','$RESTORED_FILES'].map((Bucket) => c.send(new CreateBucketCommand({ Bucket }))))
  .then(() => console.log('compartiments prêts'));"

say "1. Images construites comme sur Railway (Dockerfile sans cible, Dockerfile.ops)"
cd "$ROOT"
docker build -q --network host ${BUILD_CA:+--secret id=ca,src=$BUILD_CA} --build-arg NODE_IMAGE="$NODE_IMAGE" \
  -f deploy/Dockerfile -t campplanner-web:$V . >/dev/null
docker build -q --network host ${BUILD_CA:+--secret id=ca,src=$BUILD_CA} --build-arg NODE_IMAGE="$NODE_IMAGE" \
  --build-arg POSTGRES_IMAGE="$PG_IMAGE" -f deploy/Dockerfile.ops -t campplanner-ops:$V . >/dev/null
echo "images construites"

say "2. PostgreSQL 17 géré (volume), sans script d'initialisation"
docker volume create cp-sim-pg >/dev/null
docker run -d --name cp-sim-pg --network host -e POSTGRES_PASSWORD="$PG_PW" -e POSTGRES_DB=railway \
  -v cp-sim-pg:/var/lib/postgresql/data "$PG_IMAGE" -c port=55432 >/dev/null
until docker exec cp-sim-pg pg_isready -p 55432 -U postgres >/dev/null 2>&1; do sleep 1; done; sleep 2
docker exec cp-sim-pg psql -p 55432 -U postgres -Atc 'SHOW server_version' | sed 's/^/version : /'

say "3. Avant déploiement (première installation : rôle, migrations, premier administrateur)"
docker run --rm --network host $HOSTS --env-file "$WORK/first.env" campplanner-web:$V npm run -s server:predeploy \
  | tee "$OUT/01-avant-deploiement.log"

say "4. Service web (sans volume) + bordure TLS"
start_web() { docker run -d --name "$1" --network host $HOSTS --env-file "$WORK/web.env" campplanner-web:$V >/dev/null; }
start_web cp-sim-web
printf 'localhost:8443 {\n  tls internal\n  reverse_proxy 127.0.0.1:7311\n}\n' > "$WORK/Caddyfile"
docker run -d --name cp-sim-edge --network host -v "$WORK/Caddyfile:/etc/caddy/Caddyfile:ro" "$CADDY_IMAGE" >/dev/null
ready() { curl -ks -o /dev/null -w '%{http_code}' "$1/api/health/ready"; }
i=0; until [ "$(ready https://localhost:8443)" = 200 ]; do i=$((i+1)); [ $i -gt 90 ] && { docker logs cp-sim-web; exit 1; }; sleep 1; done
curl -ks https://localhost:8443/api/health/ready; echo

say "5. Vérifications après déploiement (11 points + projet de démonstration, navigateurs réels)"
PILOT_URL=https://localhost:8443 PILOT_EMAIL=admin@pamm.test PILOT_PASSWORD="$ADMIN_PW" PILOT_IGNORE_TLS=1 PILOT_KEEP=1 \
  node bench/pilot-verify.mjs "$PHOTO" "$OUT/verification" | tee "$OUT/02-verification.log"

login() { # $1 base, $2 jar
  curl -ks -c "$2" -H 'X-CampPlanner: 1' -H 'Content-Type: application/json' \
    --data-binary @- "$1/api/auth/login" >/dev/null <<EOF
{"email":"admin@pamm.test","password":"$ADMIN_PW","deviceMode":"trusted"}
EOF
}
state() { # empreinte des données visibles par l'API : plans, texte d'essai, SHA-256 de la photo
  login "$1" "$WORK/jar"
  PLAN="$(curl -ks -b "$WORK/jar" "$1/api/plans" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const p=JSON.parse(s).plans.find(x=>x.name.startsWith("Plan d’essai"));console.log(p.id)})')"
  DOC="$(curl -ks -b "$WORK/jar" "$1/api/plans/$PLAN")"
  SHA="$(printf '%s' "$DOC" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).document.plan.baseImage.sha256))')"
  GOT="$(curl -ks -b "$WORK/jar" "$1/api/files/$SHA" | sha256sum | cut -d' ' -f1)"
  TEXT="$(printf '%s' "$DOC" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(Object.values(JSON.parse(s).document.objects).map(o=>o.text).filter(Boolean).join(",")))')"
  echo "plan=$PLAN version=$(printf '%s' "$DOC" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).serverVersion))') textes=$TEXT photo=$GOT"
}
BEFORE="$(state https://localhost:8443)"; echo "état : $BEFORE"

say "6. Conteneur web détruit puis recréé (redéploiement), PostgreSQL redémarré : rien de perdu"
docker rm -f cp-sim-web >/dev/null
docker restart cp-sim-pg >/dev/null
until docker exec cp-sim-pg pg_isready -p 55432 -U postgres >/dev/null 2>&1; do sleep 1; done; sleep 2
docker run --rm --network host $HOSTS --env-file "$WORK/web.env" campplanner-web:$V npm run -s server:predeploy \
  | tee "$OUT/03-redeploiement.log"
start_web cp-sim-web
i=0; until [ "$(ready https://localhost:8443)" = 200 ]; do i=$((i+1)); [ $i -gt 90 ] && exit 1; sleep 1; done
AFTER="$(state https://localhost:8443)"; echo "état : $AFTER"
[ "$BEFORE" = "$AFTER" ] && echo "identique avant/après : oui" || { echo "ÉCART après redéploiement"; exit 1; }

say "7. Sauvegarde planifiée (image ops, commande par défaut) vers le compartiment des sauvegardes"
docker run --rm --network host $HOSTS --env-file "$WORK/web.env" campplanner-ops:$V | tee "$OUT/04-sauvegarde.log"
docker run --rm --network host $HOSTS --env-file "$WORK/web.env" campplanner-ops:$V server/scripts/backup-bucket.ts list

say "8. Restauration sur une NOUVELLE base (autre PostgreSQL 17) et un AUTRE compartiment de fichiers"
docker volume create cp-sim-pg2 >/dev/null
docker run -d --name cp-sim-pg2 --network host -e POSTGRES_PASSWORD="$PG_PW" -e POSTGRES_DB=railway \
  -v cp-sim-pg2:/var/lib/postgresql/data "$PG_IMAGE" -c port=55433 >/dev/null
until docker exec cp-sim-pg2 pg_isready -p 55433 -U postgres >/dev/null 2>&1; do sleep 1; done; sleep 2
web_env 55433 "$RESTORED_FILES" > "$WORK/restored.env"; chmod 600 "$WORK/restored.env"
docker run --rm --network host $HOSTS --env-file "$WORK/restored.env" campplanner-ops:$V \
  server/scripts/backup-bucket.ts restore | tee "$OUT/05-restauration.log"
docker run --rm --network host $HOSTS --env-file "$WORK/restored.env" campplanner-web:$V npm run -s server:predeploy >/dev/null
docker run -d --name cp-sim-web2 --network host $HOSTS --env-file "$WORK/restored.env" -e PORT=7312 \
  -e PUBLIC_ORIGIN=http://localhost:7312 -e COOKIE_SECURE=false campplanner-web:$V >/dev/null
i=0; until [ "$(ready http://localhost:7312)" = 200 ]; do i=$((i+1)); [ $i -gt 90 ] && exit 1; sleep 1; done
RESTORED="$(state http://localhost:7312)"; echo "état restauré : $RESTORED"
[ "$BEFORE" = "$RESTORED" ] && echo "identique à l'original : oui" || { echo "ÉCART après restauration"; exit 1; }

say "9. Aucun secret dans les journaux (conteneurs et sorties)"
LOGS="$WORK/all.log"
for c in cp-sim-web cp-sim-web2 cp-sim-edge; do docker logs "$c" >>"$LOGS" 2>&1 || true; done
cat "$OUT"/*.log "$OUT"/verification/*.json >>"$LOGS" 2>/dev/null || true
LEAK=0
for s in "$PG_PW" "$APP_PW" "$ADMIN_PW" "$AWS_SECRET_ACCESS_KEY"; do grep -qF "$s" "$LOGS" && LEAK=1; done
[ $LEAK = 0 ] && echo "aucun mot de passe ni clé dans les journaux : vérifié" || { echo "SECRET TROUVÉ DANS UN JOURNAL"; exit 1; }
say "Simulation Railway réussie."
