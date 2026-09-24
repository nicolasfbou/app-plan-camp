-- Génération du serveur : identifiant renouvelé à chaque RESTAURATION d'une sauvegarde. Un
-- appareil qui voit la génération changer sait que l'historique du serveur a été remplacé
-- (retour arrière) : il relit tout depuis le début et présente chaque différence comme un
-- conflit, jamais comme un écrasement silencieux dans un sens ou dans l'autre.
CREATE TABLE server_meta (
  key text PRIMARY KEY,
  value text NOT NULL
);
INSERT INTO server_meta (key, value) VALUES ('generation', gen_random_uuid()::text);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'campplanner_app') THEN
    GRANT SELECT ON server_meta TO campplanner_app;
  END IF;
END $$;
