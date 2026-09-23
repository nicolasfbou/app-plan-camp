/**
 * PostgreSQL RÉEL pour les tests serveur : `TEST_DATABASE_URL` (serveur existant, rôle
 * superutilisateur) ou, à défaut, une instance temporaire créée pour la durée des tests.
 */
import type { TestProject } from 'vitest/node';
import { startCluster } from './pgCluster.ts';

declare module 'vitest' {
  export interface ProvidedContext {
    pgAdminUrl: string;
  }
}

export default function setup(project: TestProject) {
  if (process.env.TEST_DATABASE_URL) {
    project.provide('pgAdminUrl', process.env.TEST_DATABASE_URL);
    return;
  }
  const cluster = startCluster();
  project.provide('pgAdminUrl', cluster.adminUrl);
  return () => cluster.stop();
}
