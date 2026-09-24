#!/bin/sh
# Premier démarrage de PostgreSQL : rôle applicatif SANS droits de propriétaire (la RLS s'applique
# à lui). Mot de passe lu dans un secret monté, jamais écrit ici.
set -eu
APP_PASSWORD="$(cat /run/secrets/campplanner_app_db_password)"
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v app_password="$APP_PASSWORD" <<'SQL'
SELECT format('CREATE ROLE campplanner_app LOGIN PASSWORD %L', :'app_password')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'campplanner_app') \gexec
GRANT CONNECT ON DATABASE campplanner TO campplanner_app;
GRANT USAGE ON SCHEMA public TO campplanner_app;
SQL
