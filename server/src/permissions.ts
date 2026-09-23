/**
 * Rôles et permissions (volontairement simples). UNE fonction décide : `can(role, action)`.
 * L'interface masque ce qui est interdit ; le serveur revérifie TOUT.
 */
import type { Client } from './db.ts';
import { forbidden, notFound } from './errors.ts';

export const ROLES = ['admin', 'manager', 'editor', 'reader'] as const;
export type Role = (typeof ROLES)[number];

export type Action =
  | 'read'
  | 'plan.write'
  | 'plan.create'
  | 'plan.delete'
  | 'camp.write'
  | 'camp.delete'
  | 'revision.create'
  | 'revision.status'
  | 'revision.approve'
  | 'revision.delete'
  | 'template.write'
  | 'publish'
  | 'audit.read'
  | 'members.read'
  | 'members.manage';

const MATRIX: Record<Role, ReadonlySet<Action>> = {
  reader: new Set(['read']),
  editor: new Set(['read', 'plan.write', 'revision.create']),
  manager: new Set([
    'read',
    'plan.write',
    'plan.create',
    'plan.delete',
    'camp.write',
    'camp.delete',
    'revision.create',
    'revision.status',
    'revision.approve',
    'revision.delete',
    'template.write',
    'publish',
    'audit.read',
    'members.read',
  ]),
  admin: new Set([
    'read',
    'plan.write',
    'plan.create',
    'plan.delete',
    'camp.write',
    'camp.delete',
    'revision.create',
    'revision.status',
    'revision.approve',
    'revision.delete',
    'template.write',
    'publish',
    'audit.read',
    'members.read',
    'members.manage',
  ]),
};

export const can = (role: Role, action: Action) => MATRIX[role].has(action);

export interface Auth {
  userId: string;
  orgId: string;
  role: Role;
  email: string;
  displayName: string;
  sessionHash: string;
  deviceMode: 'trusted' | 'shared';
}

export function requirePermission(auth: Auth, action: Action) {
  if (!can(auth.role, action)) throw forbidden();
}

/**
 * Restriction par camp (facultative) : un Éditeur ou un Lecteur ayant au moins une ligne dans
 * `camp_access` n'accède qu'à ces camps. Administrateur et Gestionnaire : toute l'organisation.
 */
export async function allowedCampIds(client: Client, auth: Auth): Promise<Set<string> | null> {
  if (auth.role === 'admin' || auth.role === 'manager') return null;
  const rows = await client.query<{ camp_id: string }>('SELECT camp_id FROM camp_access WHERE user_id = $1', [
    auth.userId,
  ]);
  return rows.rows.length ? new Set(rows.rows.map((r) => r.camp_id)) : null;
}

/** 404 (jamais 403) pour un camp hors de portée : on ne révèle pas son existence. */
export async function requireCampAccess(client: Client, auth: Auth, campId: string) {
  const allowed = await allowedCampIds(client, auth);
  if (allowed && !allowed.has(campId)) throw notFound('Camp');
}
