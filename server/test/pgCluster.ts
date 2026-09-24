/**
 * Instance PostgreSQL temporaire (tests, démonstrations) : initdb dans un dossier temporaire,
 * démarrage sur un port libre, rôle applicatif `campplanner_app` (non propriétaire), arrêt et
 * suppression à la fin. En root, les commandes passent par l'utilisateur système « postgres ».
 */
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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

const PREFIX = 'campplanner-pg-';

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

function stopDir(dir: string) {
  try {
    if (existsSync(join(dir, 'data', 'postmaster.pid')))
      run([`${BIN}/pg_ctl`, '-D', `${dir}/data`, '-m', 'immediate', 'stop']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Instances laissées par un processus arrêté brutalement (SIGKILL : aucun nettoyage possible) :
 * arrêtées et supprimées au démarrage suivant. Sans cela elles s'accumulent et ralentissent la
 * machine (cause d'instabilité des tests constatée en phase 9.1 : 27 instances orphelines).
 */
export function sweepOrphanClusters() {
  for (const name of readdirSync(tmpdir())) {
    if (!name.startsWith(PREFIX)) continue;
    const dir = join(tmpdir(), name);
    let owner = 0;
    try {
      owner = Number(readFileSync(join(dir, 'owner.pid'), 'utf8'));
    } catch {
      // ancien format (sans propriétaire) : considéré orphelin
    }
    if (owner && alive(owner)) continue;
    try {
      stopDir(dir);
    } catch {
      // déjà arrêtée / en cours de suppression par un autre processus
    }
  }
}

export function startCluster(): { adminUrl: string; stop(): void } {
  sweepOrphanClusters();
  const dir = mkdtempSync(join(tmpdir(), PREFIX));
  writeFileSync(join(dir, 'owner.pid'), String(process.pid));
  chmodSync(dir, 0o777);
  if (process.getuid?.() === 0) execFileSync('chown', ['postgres', dir]);
  run([`${BIN}/initdb`, '-D', `${dir}/data`, '-A', 'trust', '-U', 'postgres', '-E', 'UTF8']);
  // Port tiré au hasard : il peut être déjà pris (plage des ports éphémères du système). Échec de
  // démarrage = nouvel essai sur un autre port ; au dernier échec, le journal de PostgreSQL est
  // joint à l'erreur et le dossier est supprimé (jamais d'instance à moitié démarrée laissée).
  let port: number;
  for (let attempt = 1; ; attempt++) {
    port = 56000 + Math.floor(Math.random() * 4000);
    try {
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
      break;
    } catch (error) {
      let log = '';
      try {
        log = readFileSync(join(dir, 'log'), 'utf8').split('\n').slice(-8).join('\n');
      } catch {
        // pas de journal
      }
      if (attempt >= 5) {
        stopDir(dir);
        throw new Error(`${error instanceof Error ? error.message : String(error)}\n${log}`, {
          cause: error,
        });
      }
      console.warn(`[pgCluster] démarrage refusé sur le port ${port} (essai ${attempt}) :\n${log}`);
    }
  }
  const adminUrl = `postgres://postgres@127.0.0.1:${port}/postgres`;
  run([`${BIN}/psql`, adminUrl, '-c', 'CREATE ROLE campplanner_app LOGIN']);
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    stopDir(dir);
  };
  // Arrêt du processus (normal ou par signal) : l'instance est toujours arrêtée.
  process.once('exit', stop);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const)
    process.once(signal, () => {
      stop();
      process.exit(128);
    });
  return { adminUrl, stop };
}
