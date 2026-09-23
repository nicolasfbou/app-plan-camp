-- Corrections issues de la revue indépendante de la phase 9.

-- Idempotence : empreinte de la requête d'origine. Une clé rejouée avec un contenu différent est
-- refusée (sinon le client croirait envoyé un contenu que le serveur n'a jamais enregistré).
ALTER TABLE idempotency_keys ADD COLUMN request_sha256 text;

-- Invitations : tentatives de mot de passe comptées (compte existant), révocation possible.
ALTER TABLE invitations ADD COLUMN failed_attempts int NOT NULL DEFAULT 0;
ALTER TABLE invitations ADD COLUMN revoked_at timestamptz;

-- Deux révisions actives d'un même plan ne partagent jamais un libellé (envois concurrents).
CREATE UNIQUE INDEX revisions_plan_label ON revisions (organization_id, plan_id, upper(label))
  WHERE deleted_at IS NULL;
