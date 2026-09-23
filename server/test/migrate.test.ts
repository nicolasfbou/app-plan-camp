import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tx } from '../src/db.ts';
import { createTestDatabase } from './db.ts';

let db: Awaited<ReturnType<typeof createTestDatabase>>;
beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(() => db.drop());

describe('schéma et garde-fous PostgreSQL', () => {
  it('RLS : le rôle applicatif ne voit que l’organisation fixée par la transaction', async () => {
    const [a, b] = (
      await db.owner.query<{ id: string }>(
        "INSERT INTO organizations (name, slug) VALUES ('PAMM', 'pamm'), ('Autre', 'autre') RETURNING id",
      )
    ).rows;
    const user = (
      await db.owner.query<{ id: string }>(
        "INSERT INTO users (email, display_name) VALUES ('a@pamm.test', 'A') RETURNING id",
      )
    ).rows[0]!.id;
    await db.owner.query(
      "INSERT INTO camps (organization_id, id, name, created_by, updated_by) VALUES ($1, 'camp-aaa', 'Camp A', $2, $2)",
      [a!.id, user],
    );
    expect((await db.pool.query('SELECT count(*)::int AS n FROM camps')).rows[0].n).toBe(0);
    const seenByA = await tx(db.pool, { orgId: a!.id, userId: user }, (c) => c.query('SELECT id FROM camps'));
    expect(seenByA.rows.map((r) => r.id)).toEqual(['camp-aaa']);
    const seenByB = await tx(db.pool, { orgId: b!.id, userId: user }, (c) => c.query('SELECT id FROM camps'));
    expect(seenByB.rows).toHaveLength(0);
    // Écriture dans une autre organisation que celle de la transaction : refusée par la politique.
    await expect(
      tx(db.pool, { orgId: b!.id, userId: user }, (c) =>
        c.query(
          "INSERT INTO camps (organization_id, id, name, created_by, updated_by) VALUES ($1, 'camp-bbb', 'X', $2, $2)",
          [a!.id, user],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('audit en ajout seul : ni modification ni suppression, même par le propriétaire', async () => {
    const org = (await db.owner.query<{ id: string }>('SELECT id FROM organizations LIMIT 1')).rows[0]!.id;
    await db.owner.query(
      "INSERT INTO audit_events (organization_id, action, target_kind, target_id) VALUES ($1, 'x', 'plan', 'p')",
      [org],
    );
    await expect(db.owner.query("UPDATE audit_events SET action = 'y'")).rejects.toThrow(/ajout seul/);
    await expect(db.owner.query('DELETE FROM audit_events')).rejects.toThrow(/ajout seul/);
    await expect(
      tx(db.pool, { orgId: org, userId: null }, (c) => c.query("UPDATE audit_events SET action = 'y'")),
    ).rejects.toThrow(/permission denied|ajout seul/);
  });
});
