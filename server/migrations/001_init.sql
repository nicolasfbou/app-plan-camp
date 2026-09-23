-- CampPlanner — schéma serveur initial (phase 9).
-- Règles : toute donnée métier porte organization_id ; clés composites (organization_id, id) ;
-- sécurité au niveau des lignes (RLS, FORCE) sur les tables métier ; historique, instantanés et
-- audit en ajout seul ; révisions approuvées immuables (déclencheurs).

CREATE EXTENSION IF NOT EXISTS citext;

-- --- Identité et organisations (hors RLS : accès toujours filtré par la session) -------------

CREATE TABLE organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  slug citext NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9-]{2,60}$'),
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email citext NOT NULL UNIQUE CHECK (length(email) BETWEEN 3 AND 320),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz
);

-- Moyens d'authentification d'un même compte : mot de passe aujourd'hui, fournisseur externe
-- (Microsoft Entra ID / OIDC) plus tard — rattaché au MÊME utilisateur, jamais un second compte.
CREATE TABLE user_identities (
  user_id uuid NOT NULL REFERENCES users(id),
  provider text NOT NULL CHECK (provider IN ('password', 'oidc')),
  -- password : '' ; oidc : « issuer|subject »
  subject text NOT NULL DEFAULT '',
  secret_hash text, -- argon2id (mot de passe) ; NULL pour un fournisseur externe
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, provider, subject)
);
CREATE UNIQUE INDEX user_identities_external ON user_identities (provider, subject) WHERE provider <> 'password';

CREATE TABLE memberships (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  user_id uuid NOT NULL REFERENCES users(id),
  role text NOT NULL CHECK (role IN ('admin', 'manager', 'editor', 'reader')),
  -- Accès à CETTE organisation suspendu par son administrateur (le compte peut rester actif
  -- dans une autre organisation).
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, user_id)
);

CREATE TABLE invitations (
  token_hash text PRIMARY KEY, -- SHA-256 du jeton (le jeton lui-même n'est jamais stocké)
  organization_id uuid NOT NULL REFERENCES organizations(id),
  email citext NOT NULL,
  role text NOT NULL CHECK (role IN ('admin', 'manager', 'editor', 'reader')),
  invited_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  accepted_by uuid REFERENCES users(id)
);

CREATE TABLE sessions (
  id_hash text PRIMARY KEY, -- SHA-256 du jeton de session
  user_id uuid NOT NULL REFERENCES users(id),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  device_mode text NOT NULL CHECK (device_mode IN ('trusted', 'shared')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE INDEX sessions_user ON sessions (user_id);

-- --- Données métier (RLS) ---------------------------------------------------------------------

CREATE TABLE camps (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  id text NOT NULL CHECK (id ~ '^[A-Za-z0-9_-]{6,64}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  notes text NOT NULL DEFAULT '',
  created_by uuid NOT NULL REFERENCES users(id),
  updated_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  server_version bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (organization_id, id)
);

CREATE TABLE plans (
  organization_id uuid NOT NULL,
  id text NOT NULL CHECK (id ~ '^[A-Za-z0-9_-]{6,64}$'),
  camp_id text NOT NULL,
  name text NOT NULL,
  kind text NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  created_by uuid NOT NULL REFERENCES users(id),
  updated_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  server_version bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (organization_id, id),
  FOREIGN KEY (organization_id, camp_id) REFERENCES camps(organization_id, id)
);

-- Historique COMPLET des versions de chaque plan (ajout seul) : aucune version n'est détruite,
-- même quand un utilisateur choisit explicitement de garder sa version dans un conflit.
CREATE TABLE plan_versions (
  organization_id uuid NOT NULL,
  plan_id text NOT NULL,
  version bigint NOT NULL,
  base_version bigint NOT NULL,
  document jsonb NOT NULL,
  document_sha256 text NOT NULL,
  schema_version int NOT NULL,
  author_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, plan_id, version),
  FOREIGN KEY (organization_id, plan_id) REFERENCES plans(organization_id, id)
);

CREATE TABLE revisions (
  organization_id uuid NOT NULL,
  id text NOT NULL CHECK (id ~ '^[A-Za-z0-9_-]{6,64}$'),
  plan_id text NOT NULL,
  label text NOT NULL,
  -- json (et non jsonb) : texte conservé à l'identique (ordre des clés), le sceau en dépend.
  meta json NOT NULL,
  snapshot_sha256 text NOT NULL,
  seal text NOT NULL,
  status text NOT NULL,
  -- Type de vérification de l'approbation : jamais déduit ni réécrit après coup.
  verification_type text CHECK (verification_type IN ('local_unverified', 'authenticated_server')),
  approved_at timestamptz,  -- date SERVEUR (approbation authentifiée)
  approved_by uuid REFERENCES users(id),
  parent_id text,
  parent_seal text,
  chain_hash text NOT NULL,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  PRIMARY KEY (organization_id, id),
  FOREIGN KEY (organization_id, plan_id) REFERENCES plans(organization_id, id)
);

CREATE TABLE revision_snapshots (
  organization_id uuid NOT NULL,
  revision_id text NOT NULL,
  json text NOT NULL,
  PRIMARY KEY (organization_id, revision_id),
  FOREIGN KEY (organization_id, revision_id) REFERENCES revisions(organization_id, id)
);

CREATE TABLE files (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  sha256 char(64) NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  byte_length bigint NOT NULL CHECK (byte_length > 0),
  mime_type text NOT NULL,
  storage_key text NOT NULL,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, sha256)
);

CREATE TABLE file_refs (
  organization_id uuid NOT NULL,
  sha256 char(64) NOT NULL,
  owner_kind text NOT NULL CHECK (owner_kind IN ('plan', 'revision', 'template')),
  owner_id text NOT NULL,
  PRIMARY KEY (organization_id, sha256, owner_kind, owner_id),
  FOREIGN KEY (organization_id, sha256) REFERENCES files(organization_id, sha256)
);

CREATE TABLE templates (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  id text NOT NULL CHECK (id ~ '^[A-Za-z0-9_-]{6,64}$'),
  name text NOT NULL,
  body jsonb NOT NULL,
  logo_sha256 char(64),
  created_by uuid NOT NULL REFERENCES users(id),
  updated_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  server_version bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (organization_id, id)
);

CREATE TABLE camp_access (
  organization_id uuid NOT NULL,
  camp_id text NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id),
  PRIMARY KEY (organization_id, camp_id, user_id),
  FOREIGN KEY (organization_id, camp_id) REFERENCES camps(organization_id, id)
);

-- Journal des changements (curseur de synchronisation) : ajout seul.
CREATE TABLE change_log (
  seq bigserial PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  kind text NOT NULL CHECK (kind IN ('camp', 'plan', 'revision', 'template')),
  entity_id text NOT NULL,
  server_version bigint NOT NULL,
  deleted boolean NOT NULL DEFAULT false,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX change_log_org_seq ON change_log (organization_id, seq);

-- Réponses mémorisées des requêtes rejouées (idempotence).
CREATE TABLE idempotency_keys (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  key text NOT NULL CHECK (length(key) BETWEEN 8 AND 200),
  user_id uuid NOT NULL REFERENCES users(id),
  route text NOT NULL,
  status int NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, key)
);

-- Journal d'audit : ajout seul, jamais modifié ni supprimé.
CREATE TABLE audit_events (
  id bigserial PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  user_id uuid REFERENCES users(id),
  action text NOT NULL,
  target_kind text NOT NULL,
  target_id text NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  request_id text,
  context jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX audit_events_org_at ON audit_events (organization_id, at DESC);

-- --- Garde-fous en base -----------------------------------------------------------------------

CREATE FUNCTION forbid_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'campplanner: % interdit sur % (ajout seul)', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END $$;

CREATE TRIGGER audit_append_only BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER plan_versions_append_only BEFORE UPDATE OR DELETE ON plan_versions
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER snapshots_append_only BEFORE UPDATE OR DELETE ON revision_snapshots
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER change_log_append_only BEFORE UPDATE OR DELETE ON change_log
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- Révisions : l'instantané et son empreinte ne changent jamais ; une révision approuvée ne peut
-- plus changer, sauf le seul passage « approuvée → archivée » (approbation conservée) ; une
-- révision approuvée n'est jamais supprimée (ni physiquement, ni logiquement).
CREATE FUNCTION guard_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'campplanner: suppression physique d''une révision interdite'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.organization_id <> OLD.organization_id OR NEW.id <> OLD.id OR NEW.plan_id <> OLD.plan_id
     OR NEW.snapshot_sha256 <> OLD.snapshot_sha256 OR NEW.label <> OLD.label
     OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at
     OR NEW.chain_hash <> OLD.chain_hash THEN
    RAISE EXCEPTION 'campplanner: champs figés d''une révision' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (OLD.meta -> 'approval')::jsonb IS NOT NULL AND (OLD.meta -> 'approval')::jsonb <> 'null'::jsonb THEN
    IF OLD.status <> 'approved' OR NEW.status <> 'archived'
       OR (NEW.meta -> 'approval')::jsonb IS DISTINCT FROM (OLD.meta -> 'approval')::jsonb
       OR NEW.verification_type IS DISTINCT FROM OLD.verification_type
       OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
       OR NEW.approved_by IS DISTINCT FROM OLD.approved_by
       OR NEW.deleted_at IS NOT NULL THEN
      RAISE EXCEPTION 'campplanner: révision approuvée immuable (seul l''archivage est permis)'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER revisions_guard BEFORE UPDATE OR DELETE ON revisions
  FOR EACH ROW EXECUTE FUNCTION guard_revision();

-- --- Isolation des organisations (RLS, deuxième barrière après l'API) ------------------------
-- L'API positionne app.org_id au début de chaque transaction, depuis la SESSION (jamais depuis
-- la requête du client). Sans ce réglage, aucune ligne n'est visible.

CREATE FUNCTION current_org() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.org_id', true), '')::uuid
$$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['camps', 'plans', 'plan_versions', 'revisions', 'revision_snapshots',
                           'files', 'file_refs', 'templates', 'camp_access', 'change_log',
                           'idempotency_keys', 'audit_events']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY org_isolation ON %I USING (organization_id = current_org()) '
                   'WITH CHECK (organization_id = current_org())', t);
  END LOOP;
END $$;

-- Rôle applicatif (sans droits de propriétaire) : créé par l'administrateur de la base.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'campplanner_app') THEN
    GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO campplanner_app;
    GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO campplanner_app;
    REVOKE UPDATE ON audit_events, plan_versions, revision_snapshots, change_log FROM campplanner_app;
    -- Suppressions physiques : sessions, clés d'idempotence expirées, références de fichiers
    -- (recalculées à chaque enregistrement) et restrictions par camp.
    GRANT DELETE ON sessions, idempotency_keys, file_refs, camp_access TO campplanner_app;
  END IF;
END $$;
