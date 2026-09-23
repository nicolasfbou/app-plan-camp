/**
 * PostgreSQL RÉEL pour les tests serveur : `TEST_DATABASE_URL` (serveur existant, rôle
 * superutilisateur) ou, à défaut, une instance temporaire créée pour la durée des tests
 * (initdb dans /tmp, supprimée à la fin).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestProject } from 'vitest/node';

const BIN = process.env.PG_BIN ?? '/usr/lib/postgresql/16/bin';

declare module 'vitest' {
  export interface ProvidedContext {
    pgAdminUrl: string;
  }
}

function asPostgres(args: string[]) {
  // PostgreSQL refuse de tourner en root : on passe par l'utilisateur système « postgres ».
  const root = process.getuid?.() === 0;
  const [cmd, ...rest] = args;
  const r = root
    ? spawnSync('su', ['postgres', '-s', '/bin/sh', '-c', [cmd, ...rest].map((a) => `'${a}'`).join(' ')], {
        encoding: 'utf8',
      })
    : spawnSync(cmd!, rest, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${args.join(' ')} : ${r.stderr || r.stdout}`);
}

export default function setup(project: TestProject) {
  if (process.env.TEST_DATABASE_URL) {
    project.provide('pgAdminUrl', process.env.TEST_DATABASE_URL);
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), 'campplanner-pg-'));
  chmodSync(dir, 0o777);
  if (process.getuid?.() === 0) execFileSync('chown', ['postgres', dir]);
  const port = 56000 + Math.floor(Math.random() * 2000);
  asPostgres([`${BIN}/initdb`, '-D', `${dir}/data`, '-A', 'trust', '-U', 'postgres', '-E', 'UTF8']);
  asPostgres([
    `${BIN}/pg_ctl`,
    '-D',
    `${dir}/data`,
    '-o',
    `-p ${port} -k ${dir} -c fsync=off -c full_page_writes=off`,
    '-l',
    `${dir}/log`,
    '-w',
    'start',
  ]);
  const url = `postgres://postgres@127.0.0.1:${port}/postgres`;
  // Rôle applicatif (non propriétaire) : créé une seule fois pour toute la série de tests.
  asPostgres([`${BIN}/psql`, url, '-c', 'CREATE ROLE campplanner_app LOGIN']);
  project.provide('pgAdminUrl', url);
  return () => {
    try {
      asPostgres([`${BIN}/pg_ctl`, '-D', `${dir}/data`, '-m', 'immediate', 'stop']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}
