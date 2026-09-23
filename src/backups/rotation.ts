/**
 * Politique de conservation des sauvegardes externes (logique pure, testée) et noms de fichiers.
 *
 * Nom : `<Plan> — AAAA-MM-JJ HHhMM[ss] — <genre>.campplan`, genre : `rapide`, `revision-B`,
 * `approuvee-A`. Seuls les fichiers qui suivent ce modèle sont gérés : un fichier déposé à la main
 * dans le dossier n'est jamais supprimé.
 */

export interface RetentionPolicy {
  /** Dernières sauvegardes rapides conservées. */
  quick: number;
  /** Une sauvegarde par jour, sur ce nombre de jours distincts. */
  daily: number;
  /** Une sauvegarde par semaine, sur ce nombre de semaines distinctes. */
  weekly: number;
  /** Les sauvegardes faites à l'approbation d'une révision ne sont jamais supprimées. */
  keepApproved: boolean;
}

export const DEFAULT_POLICY: RetentionPolicy = { quick: 10, daily: 7, weekly: 4, keepApproved: true };

export type BackupKind = 'quick' | 'revision' | 'approved';

export interface BackupFile {
  name: string;
  at: Date;
  kind: BackupKind;
  /** Numéro de révision (sauvegardes de révision ou d'approbation). */
  label?: string;
}

const pad = (n: number) => String(n).padStart(2, '0');

export function backupStamp(at: Date): string {
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}h${pad(at.getMinutes())}m${pad(at.getSeconds())}`;
}

const safe = (text: string) =>
  text
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'plan';

export function backupFileName(planName: string, at: Date, kind: BackupKind, label?: string): string {
  const suffix =
    kind === 'quick' ? 'rapide' : `${kind === 'approved' ? 'approuvee' : 'revision'}-${safe(label ?? '')}`;
  return `${safe(planName)} — ${backupStamp(at)} — ${suffix}.campplan`;
}

const PATTERN =
  /— (\d{4})-(\d{2})-(\d{2}) (\d{2})h(\d{2})m(\d{2}) — (rapide|revision-(.+)|approuvee-(.+))\.campplan$/;

export function parseBackupFileName(name: string): BackupFile | null {
  const m = PATTERN.exec(name);
  if (!m) return null;
  const at = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
  if (Number.isNaN(at.getTime())) return null;
  if (m[7] === 'rapide') return { name, at, kind: 'quick' };
  if (m[8] !== undefined) return { name, at, kind: 'revision', label: m[8] };
  return { name, at, kind: 'approved', label: m[9] };
}

const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
function weekKey(d: Date): string {
  // Semaine ISO (lundi) : année et numéro.
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const year = t.getUTCFullYear();
  const week = Math.ceil(((t.getTime() - Date.UTC(year, 0, 1)) / 86400000 + 1) / 7);
  return `${year}-W${week}`;
}

/**
 * Fichiers à supprimer selon la politique. Conservés : les `quick` plus récents, le plus récent de
 * chacun des `daily` derniers jours, le plus récent de chacune des `weekly` dernières semaines,
 * et toutes les sauvegardes d'approbation (si `keepApproved`). Jamais la plus récente.
 */
export function selectBackupsToDelete(files: readonly BackupFile[], policy: RetentionPolicy): string[] {
  const keep = new Set<string>();
  const sorted = [...files].sort((a, b) => b.at.getTime() - a.at.getTime());
  if (sorted[0]) keep.add(sorted[0].name);
  const rotating = sorted.filter((f) => !(policy.keepApproved && f.kind === 'approved'));
  for (const f of sorted) if (policy.keepApproved && f.kind === 'approved') keep.add(f.name);
  rotating.slice(0, Math.max(0, policy.quick)).forEach((f) => keep.add(f.name));
  const byBucket = (key: (d: Date) => string, count: number) => {
    const seen = new Set<string>();
    for (const f of rotating) {
      const k = key(f.at);
      if (seen.has(k)) continue;
      if (seen.size >= count) break;
      seen.add(k);
      keep.add(f.name); // le plus récent de ce jour / de cette semaine
    }
  };
  byBucket(dayKey, Math.max(0, policy.daily));
  byBucket(weekKey, Math.max(0, policy.weekly));
  return sorted.filter((f) => !keep.has(f.name)).map((f) => f.name);
}
