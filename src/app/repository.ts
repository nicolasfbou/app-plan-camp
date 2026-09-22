import { IndexedDbRepository } from '@/persistence/indexedDbRepository.ts';
import type { ProjectRepository } from '@/persistence/ProjectRepository.ts';

/** Dépôt unique de l'application (IndexedDB en V1). */
export const repository: ProjectRepository = new IndexedDbRepository();
