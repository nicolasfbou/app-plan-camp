#!/bin/sh
# Génère des secrets ALÉATOIRES pour un essai local (deploy/secrets/, ignoré par Git).
# En production : utiliser le coffre de secrets de l'hébergeur ; ne jamais copier ces fichiers.
#
# Les secrets « fichier » de Docker Compose sont montés avec les droits de l'hôte : chaque fichier
# appartient à l'utilisateur du conteneur qui le lit (lecture seule pour lui, rien pour les autres) :
#   PostgreSQL (image officielle) : uid 999 ; serveur CampPlanner (image node) : uid 1000.
set -eu
cd "$(dirname "$0")"
mkdir -p secrets
umask 077
[ -f secrets/owner_db_password ] || head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > secrets/owner_db_password
[ -f secrets/app_db_password ] || head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > secrets/app_db_password
printf 'postgres://campplanner_owner:%s@db:5432/campplanner' "$(cat secrets/owner_db_password)" > secrets/migration_url
printf 'postgres://campplanner_app:%s@db:5432/campplanner' "$(cat secrets/app_db_password)" > secrets/database_url
chmod 0400 secrets/*
if [ "$(id -u)" = 0 ]; then
  chown 999:999 secrets/owner_db_password secrets/app_db_password
  chown 1000:1000 secrets/database_url secrets/migration_url
else
  echo "Attention : lancez ce script avec sudo pour attribuer les secrets aux utilisateurs des conteneurs (999, 1000)." >&2
fi
echo "Secrets locaux prêts dans deploy/secrets/ (ne pas commiter)."
