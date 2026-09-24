#!/bin/sh
# Essai de fumée du déploiement de référence (docker compose), sur un hôte de TEST uniquement :
# HTTPS, contrôle de santé, premier administrateur, envoi d'une photo, redémarrage (persistance),
# sauvegarde complète, restauration dans une pile ISOLÉE (autre projet, autres volumes),
# comparaison des SHA-256. Ne jamais lancer contre la production.
#
#   PHOTO=/chemin/photo.jpg ./deploy/smoke-test.sh
# Variables utiles : HTTPS_PORT (8443), CAMPPLANNER_VERSION, POSTGRES_IMAGE, CADDY_IMAGE.
set -eu
cd "$(dirname "$0")"
PHOTO="${PHOTO:?chemin d'une photo JPEG à envoyer}"
PORT="${HTTPS_PORT:-8443}"
BASE="https://localhost:${PORT}"
DC="docker compose -f docker-compose.yml"
PASS="essai-de-fumee-$(head -c 8 /dev/urandom | od -An -tx1 | tr -d ' \n')"
JAR="$(mktemp)"
say() { printf '\n== %s\n' "$*"; }
ready() { curl -ks -o /dev/null -w '%{http_code}' "$1/api/health/ready"; }
wait_ready() { i=0; until [ "$(ready "$1")" = 200 ]; do i=$((i+1)); [ $i -gt 60 ] && { echo "pas prêt : $1"; exit 1; }; sleep 2; done; }

say "1. HTTPS et contrôle de santé"
wait_ready "$BASE"
curl -ks "$BASE/api/health/ready"; echo
curl -ksI "$BASE/" | grep -iE '^(HTTP|strict-transport-security|x-content-type-options)'
printf 'HTTP → HTTPS : '; curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' "http://localhost:${HTTP_PORT:-8088}/"

say "2. Premier administrateur (mot de passe aléatoire, jamais écrit sur disque)"
$DC run --rm --no-deps -e BOOTSTRAP_PASSWORD="$PASS" migrate \
  node_modules/.bin/tsx --tsconfig server/tsconfig.json server/scripts/bootstrap.ts \
  --org PAMM --slug pamm --email admin@pamm.test --name "Admin PAMM" | tail -1

say "3. Connexion, camp, envoi de la photo"
H='-H X-CampPlanner:1 -H Content-Type:application/json'
curl -ks -c "$JAR" $H -d "{\"email\":\"admin@pamm.test\",\"password\":\"$PASS\",\"deviceMode\":\"trusted\"}" "$BASE/api/auth/login" | head -c 160; echo
curl -ks -b "$JAR" $H -X PUT -H If-Match:0 -d '{"name":"Camp 105 (essai)"}' "$BASE/api/camps/camp-essai-105" ; echo
SHA="$(sha256sum "$PHOTO" | cut -d' ' -f1)"
curl -ks -b "$JAR" -H X-CampPlanner:1 -H Content-Type:application/octet-stream -H X-File-Type:image/jpeg \
  -X PUT --data-binary "@$PHOTO" "$BASE/api/files/$SHA"; echo
GOT="$(curl -ks -b "$JAR" "$BASE/api/files/$SHA" | sha256sum | cut -d' ' -f1)"
echo "SHA-256 original : $SHA"; echo "SHA-256 relu     : $GOT"; [ "$SHA" = "$GOT" ]

say "4. Redémarrage du serveur : données conservées"
$DC restart campplanner >/dev/null
wait_ready "$BASE"
AGAIN="$(curl -ks -b "$JAR" "$BASE/api/files/$SHA" | sha256sum | cut -d' ' -f1)"
echo "après redémarrage : $AGAIN"; [ "$SHA" = "$AGAIN" ]

say "5. Sauvegarde complète (base + fichiers) puis vérification"
STAMP="essai-$(date +%Y%m%d-%H%M%S)"
# Dossier des sauvegardes : réservé au compte du conteneur (uid 1000), jamais lisible par tous.
mkdir -p backups && chmod 700 backups
$DC --profile ops run --rm --no-deps --user 0 --entrypoint chown ops 1000:1000 /backups
$DC --profile ops run --rm ops server/scripts/backup.ts backup --out "/backups/$STAMP" | tail -4
$DC --profile ops run --rm ops server/scripts/backup.ts verify --from "/backups/$STAMP"

say "6. Restauration dans une pile ISOLÉE (projet campplanner-restauration, volumes neufs)"
R="docker compose -p campplanner-restauration -f docker-compose.yml"
$R up -d db >/dev/null 2>&1
until $R exec -T db pg_isready -U campplanner_owner -d campplanner >/dev/null 2>&1; do sleep 2; done
sleep 3
$R --profile ops run --rm -v "$(pwd)/backups:/backups" ops server/scripts/backup.ts restore --from "/backups/$STAMP" | tail -3
HTTPS_PORT=9443 HTTP_PORT=9088 $R up -d campplanner https >/dev/null 2>&1
wait_ready "https://localhost:9443"
JAR2="$(mktemp)"
curl -ks -c "$JAR2" $H -d "{\"email\":\"admin@pamm.test\",\"password\":\"$PASS\",\"deviceMode\":\"trusted\"}" https://localhost:9443/api/auth/login >/dev/null
REST="$(curl -ks -b "$JAR2" "https://localhost:9443/api/files/$SHA" | sha256sum | cut -d' ' -f1)"
echo "SHA-256 après restauration : $REST"; [ "$SHA" = "$REST" ]
curl -ks -b "$JAR2" https://localhost:9443/api/camps | head -c 200; echo
HTTPS_PORT=9443 HTTP_PORT=9088 $R down -v >/dev/null 2>&1
rm -f "$JAR" "$JAR2"
say "Essai de fumée réussi."
