/**
 * Instance PostgreSQL temporaire (tests, démonstrations) : initdb dans un dossier temporaire,
 * démarrage sur un port libre, rôle applicatif `campplanner_app` (non propriétaire), arrêt et
 * suppression à la fin. En root, les commandes passent par l'utilisateur système « postgres ».
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BIN = process.env.PG_BIN ?? '/usr/lib/postgresql/16/bin';

function run(args: string[]) {
  const root = process.getuid?.() === 0;
  const [cmd, ...rest] = args;
  const r = root
    ? spawnSync('su', ['postgres', '-s', '/bin/sh', '-c', [cmd, ...rest].map((a) => `'${a}'`).join(' ')], {
        encoding: 'utf8',
      })
    : spawnSync(cmd!, rest, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${args.join(' ')} : ${r.stderr || r.stdout}`);
}

export function startCluster(): { adminUrl: string; stop(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'campplanner-pg-'));
  chmodSync(dir, 0o777);
  if (process.getuid?.() === 0) execFileSync('chown', ['postgres', dir]);
  const port = 56000 + Math.floor(Math.random() * 4000);
  run([`${BIN}/initdb`, '-D', `${dir}/data`, '-A', 'trust', '-U', 'postgres', '-E', 'UTF8']);
  run([
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
  const adminUrl = `postgres://postgres@127.0.0.1:${port}/postgres`;
  run([`${BIN}/psql`, adminUrl, '-c', 'CREATE ROLE campplanner_app LOGIN']);
  return {
    adminUrl,
    stop() {
      try {
        run([`${BIN}/pg_ctl`, '-D', `${dir}/data`, '-m', 'immediate', 'stop']);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}
