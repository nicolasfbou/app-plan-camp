# syntax=docker/dockerfile:1
# CampPlanner — image du serveur (API + application construite, même origine).
# Construction : docker build -f deploy/Dockerfile -t campplanner:<version> .
# Aucun secret dans l'image : tout vient de l'environnement ou de fichiers de secrets montés.
# Réseau d'entreprise avec inspection TLS : fournir l'autorité de certification au MOMENT de la
# construction seulement (jamais copiée dans l'image) :
#   docker build --secret id=ca,src=/chemin/ca.pem …

ARG NODE_IMAGE=node:22-bookworm-slim
ARG POSTGRES_IMAGE=postgres:16-bookworm

FROM ${NODE_IMAGE} AS build
WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json package-lock.json ./
RUN --mount=type=secret,id=ca,required=false \
    if [ -f /run/secrets/ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/ca npm_config_cafile=/run/secrets/ca; fi; \
    npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    PORT=8787 \
    STATIC_DIR=/app/dist \
    STORAGE_FS_ROOT=/data/files
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=secret,id=ca,required=false \
    if [ -f /run/secrets/ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/ca npm_config_cafile=/run/secrets/ca; fi; \
    npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
# Code du serveur + domaine partagé (importé par le serveur) + application construite.
COPY --from=build /app/dist ./dist
COPY server ./server
COPY src ./src
COPY tsconfig.json tsconfig.app.json tsconfig.node.json ./
RUN mkdir -p /data/files && chown -R node:node /data
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node_modules/.bin/tsx", "--tsconfig", "server/tsconfig.json", "server/src/main.ts"]

# Image d'exploitation (sauvegarde, restauration, migrations, nettoyage) : outils PostgreSQL 16
# officiels (pg_dump / pg_restore de la même version que le serveur) + Node et l'application.
#   docker build -f deploy/Dockerfile --target ops -t campplanner-ops:<version> .
FROM ${POSTGRES_IMAGE} AS ops
COPY --from=runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=runtime /app /app
WORKDIR /app
ENV NODE_ENV=production PG_BIN=/usr/lib/postgresql/16/bin STORAGE_FS_ROOT=/data/files
ENTRYPOINT ["node_modules/.bin/tsx", "--tsconfig", "server/tsconfig.json"]
CMD ["server/scripts/backup.ts"]

# Cible par défaut : le serveur.
FROM runtime AS server
