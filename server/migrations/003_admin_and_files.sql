-- Phase 9.1 : administration des invitations ; protection des fichiers sur tout l'historique.

-- Invitations : identifiant stable (liste, révocation, renvoi avec un nouveau jeton).
ALTER TABLE invitations ADD COLUMN id uuid NOT NULL DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX invitations_id ON invitations (id);
ALTER TABLE invitations ADD COLUMN revoked_by uuid REFERENCES users(id);
CREATE INDEX invitations_org ON invitations (organization_id, created_at DESC);

-- Références de fichiers CUMULÉES : un fichier cité par une ancienne version d'un plan reste
-- protégé (restauration, historique). Rattrapage pour les versions déjà enregistrées.
INSERT INTO file_refs (organization_id, sha256, owner_kind, owner_id)
SELECT DISTINCT v.organization_id, s.sha, 'plan', v.plan_id
  FROM plan_versions v
 CROSS JOIN LATERAL (
       SELECT v.document #>> '{plan,baseImage,sha256}' AS sha
       UNION SELECT v.document #>> '{plan,baseImage,source,pdfSha256}'
       UNION SELECT a.value ->> 'sha256' FROM jsonb_each(coalesce(v.document -> 'assets', '{}'::jsonb)) a
     ) s
  JOIN files f ON f.organization_id = v.organization_id AND f.sha256 = s.sha
 WHERE s.sha IS NOT NULL
ON CONFLICT DO NOTHING;

-- Plus aucune suppression de référence par l'application (seule la maintenance, avec le rôle
-- propriétaire, retire des fichiers jamais référencés).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'campplanner_app') THEN
    REVOKE DELETE ON file_refs FROM campplanner_app;
  END IF;
END $$;

-- Périodes d'accès : chaque suspension d'un membre ouvre une nouvelle période. Une session n'est
-- valable que dans la période où elle a été ouverte ; une opération hors ligne créée dans une
-- période révoquée n'est jamais acceptée automatiquement (voir docs/PHASE9-SERVER.md, révocation).
ALTER TABLE memberships ADD COLUMN access_epoch int NOT NULL DEFAULT 1;
ALTER TABLE sessions ADD COLUMN access_epoch int NOT NULL DEFAULT 1;
