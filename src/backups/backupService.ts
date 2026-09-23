/**
 * Sauvegardes externes automatiques : un fichier `.campplan` horodaté par plan, écrit HORS du
 * navigateur (un navigateur qui vide son stockage ne fait jamais perdre le projet).
 *
 * Destination :
 * - dossier choisi par l'utilisateur (File System Access API, Chromium / Edge) : écriture
 *   automatique ; l'autorisation est redemandée par un clic si le navigateur l'a retirée ;
 * - sinon (Firefox, Safari…) : téléchargement. Le navigateur n'autorise pas d'écrire en silence :
 *   un rappel propose de télécharger les plans modifiés en un clic.
 *
 * Déclencheurs : intervalle (15 min, 1 h), sortie d'un plan / masquage de l'onglet, création ou
 * approbation d'une révision, bouton « sauvegarder maintenant ». Un seul onglet planifie (verrou).
 * Rotation selon la politique (`rotation.ts`) ; historique local des sauvegardes.
 */
import { create } from 'zustand';
import { repository } from '@/app/repository.ts';
import { downloadBytes } from '@/app/download.ts';
import { logEvent } from '@/diagnostics/errorLog.ts';
import { DamagedRevisionsError, exportCampplan } from '@/persistence/campplan.ts';
import { exportEmergency } from '@/persistence/emergency.ts';
import type { ProjectRepository } from '@/persistence/ProjectRepository.ts';
import {
  backupFileName,
  DEFAULT_POLICY,
  parseBackupFileName,
  type BackupKind,
  type RetentionPolicy,
  selectBackupsToDelete,
} from './rotation.ts';

// --- Types minimaux de la File System Access API (absents de lib.dom) ------------------------------

type PermissionMode = { mode: 'readwrite' };
export interface DirectoryHandle {
  kind: 'directory';
  name: string;
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<DirectoryHandle>;
  getFileHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<{
    createWritable(): Promise<{ write(data: Uint8Array): Promise<void>; close(): Promise<void> }>;
  }>;
  removeEntry(name: string): Promise<void>;
  entries?(): AsyncIterable<[string, { kind: string }]>;
  values?(): AsyncIterable<{ kind: string; name: string }>;
  queryPermission?(options: PermissionMode): Promise<PermissionState>;
  requestPermission?(options: PermissionMode): Promise<PermissionState>;
}
type PickerWindow = Window & {
  showDirectoryPicker?(options?: { mode?: 'readwrite'; id?: string }): Promise<DirectoryHandle>;
};

export const supportsFolderBackups = () =>
  typeof window !== 'undefined' && typeof (window as PickerWindow).showDirectoryPicker === 'function';

// --- Réglages et historique -----------------------------------------------------------------------

export interface BackupSettings {
  enabled: boolean;
  /** Minutes entre deux sauvegardes des plans modifiés (0 = pas d'intervalle). */
  intervalMinutes: 0 | 15 | 60;
  /** À la sortie d'un plan et au masquage / à la fermeture de l'onglet. */
  onClose: boolean;
  /** Après la création (et l'approbation) d'une révision. */
  afterRevision: boolean;
  policy: RetentionPolicy;
}

export const DEFAULT_SETTINGS: BackupSettings = {
  enabled: true,
  intervalMinutes: 15,
  onClose: true,
  afterRevision: true,
  policy: DEFAULT_POLICY,
};

export interface BackupLogEntry {
  planId: string;
  at: string;
  kind: BackupKind;
  label?: string;
  fileName: string;
  bytes: number;
  destination: 'folder' | 'download';
  ok: boolean;
  /** Copie de secours (révisions altérées exclues) plutôt qu'export normal. */
  partial?: boolean;
  error?: string;
  deleted?: number;
}

const SETTINGS_KEY = 'backup.settings';
const DIR_KEY = 'backup.directory';
const LOG_KEY = 'backup.log';
const MAX_LOG = 500;

export async function loadBackupSettings(repo: ProjectRepository = repository): Promise<BackupSettings> {
  const stored = await repo.getSetting<Partial<BackupSettings>>(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...stored, policy: { ...DEFAULT_POLICY, ...stored?.policy } };
}

export async function saveBackupSettings(settings: BackupSettings, repo: ProjectRepository = repository) {
  await repo.setSetting(SETTINGS_KEY, settings);
  useBackupStore.getState().setSettings(settings);
}

export async function readBackupLog(repo: ProjectRepository = repository): Promise<BackupLogEntry[]> {
  return (await repo.getSetting<BackupLogEntry[]>(LOG_KEY)) ?? [];
}

async function appendLog(entry: BackupLogEntry, repo: ProjectRepository) {
  const log = [...(await readBackupLog(repo)), entry].slice(-MAX_LOG);
  await repo.setSetting(LOG_KEY, log);
  useBackupStore.getState().setLog(log);
}

/** Dernière sauvegarde externe réussie d'un plan. */
export async function lastBackupOf(
  planId: string,
  repo: ProjectRepository = repository,
): Promise<BackupLogEntry | null> {
  return (await readBackupLog(repo)).filter((e) => e.planId === planId && e.ok).at(-1) ?? null;
}

// --- État partagé (interface) ---------------------------------------------------------------------

type FolderState = 'none' | 'granted' | 'needs-permission' | 'unsupported';

interface BackupState {
  settings: BackupSettings;
  folderName: string | null;
  folder: FolderState;
  log: BackupLogEntry[];
  /** Plans modifiés depuis leur dernière sauvegarde externe (rappel en mode téléchargement). */
  due: string[];
  running: boolean;
  setSettings(settings: BackupSettings): void;
  setLog(log: BackupLogEntry[]): void;
  set(partial: Partial<BackupState>): void;
}

export const useBackupStore = create<BackupState>()((set) => ({
  settings: DEFAULT_SETTINGS,
  folderName: null,
  folder: 'none',
  log: [],
  due: [],
  running: false,
  setSettings: (settings) => set({ settings }),
  setLog: (log) => set({ log }),
  set: (partial) => set(partial),
}));

// --- Dossier de destination ----------------------------------------------------------------------

async function storedDirectory(repo: ProjectRepository): Promise<DirectoryHandle | undefined> {
  return repo.getSetting<DirectoryHandle>(DIR_KEY);
}

async function permissionOf(dir: DirectoryHandle): Promise<PermissionState> {
  return dir.queryPermission ? dir.queryPermission({ mode: 'readwrite' }) : 'granted';
}

export async function refreshFolderState(repo: ProjectRepository = repository): Promise<FolderState> {
  if (!supportsFolderBackups()) {
    useBackupStore.getState().set({ folder: 'unsupported', folderName: null });
    return 'unsupported';
  }
  const dir = await storedDirectory(repo);
  if (!dir) {
    useBackupStore.getState().set({ folder: 'none', folderName: null });
    return 'none';
  }
  const state: FolderState = (await permissionOf(dir)) === 'granted' ? 'granted' : 'needs-permission';
  useBackupStore.getState().set({ folder: state, folderName: dir.name });
  return state;
}

/** Choix du dossier (geste de l'utilisateur requis). */
export async function chooseBackupFolder(repo: ProjectRepository = repository): Promise<void> {
  const picker = (window as PickerWindow).showDirectoryPicker;
  if (!picker) throw new Error('Ce navigateur ne permet pas de choisir un dossier de sauvegarde.');
  const dir = await picker.call(window, { mode: 'readwrite', id: 'campplanner-sauvegardes' });
  await repo.setSetting(DIR_KEY, dir);
  await refreshFolderState(repo);
}

/** Redemande l'autorisation d'écrire (geste de l'utilisateur requis). */
export async function regrantBackupFolder(repo: ProjectRepository = repository): Promise<boolean> {
  const dir = await storedDirectory(repo);
  if (!dir) return false;
  const granted = dir.requestPermission
    ? (await dir.requestPermission({ mode: 'readwrite' })) === 'granted'
    : true;
  await refreshFolderState(repo);
  return granted;
}

const folderSafe = (text: string) =>
  text
    .replace(/[\\/:*?"<>|]+/g, '-')
    .trim()
    .slice(0, 60) || 'sans-nom';

async function planFolder(root: DirectoryHandle, siteName: string, planName: string, planId: string) {
  const camp = await root.getDirectoryHandle(folderSafe(siteName || 'Camp'), { create: true });
  // Identifiant court dans le nom : deux plans de même nom ne partagent jamais leurs sauvegardes.
  return camp.getDirectoryHandle(`${folderSafe(planName)} [${planId.slice(0, 8)}]`, { create: true });
}

async function listFiles(dir: DirectoryHandle): Promise<string[]> {
  const names: string[] = [];
  if (dir.values) {
    for await (const e of dir.values()) if (e.kind === 'file') names.push(e.name);
  } else if (dir.entries) {
    for await (const [name, e] of dir.entries()) if (e.kind === 'file') names.push(name);
  }
  return names;
}

// --- Sauvegarde --------------------------------------------------------------------------------------

export interface BackupRequest {
  planId: string;
  kind: BackupKind;
  label?: string;
  /** Téléchargement autorisé (geste de l'utilisateur) si aucun dossier n'est utilisable. */
  allowDownload?: boolean;
  now?: Date;
}

export async function backupPlan(
  req: BackupRequest,
  repo: ProjectRepository = repository,
): Promise<BackupLogEntry> {
  const now = req.now ?? new Date();
  const summary = await repo.getPlanSummary(req.planId);
  const planName = summary?.name ?? req.planId;
  const siteName = summary ? ((await repo.getSite(summary.siteId))?.name ?? '') : '';
  const fileName = backupFileName(planName, now, req.kind, req.label);
  const base: Omit<BackupLogEntry, 'ok' | 'bytes' | 'destination'> = {
    planId: req.planId,
    at: now.toISOString(),
    kind: req.kind,
    ...(req.label ? { label: req.label } : {}),
    fileName,
  };
  let bytes: Uint8Array;
  let partial = false;
  try {
    bytes = (await exportCampplan(repo, req.planId)).bytes;
  } catch (error) {
    // Révision altérée ou autre défaut : copie de secours plutôt qu'aucune sauvegarde (signalé).
    if (!(error instanceof DamagedRevisionsError)) logEvent('backup', error, { context: fileName });
    const emergency = await exportEmergency(repo, req.planId, now);
    bytes = emergency.bytes;
    partial = !emergency.complete;
  }
  const dir = supportsFolderBackups() ? await storedDirectory(repo) : undefined;
  try {
    if (dir && (await permissionOf(dir)) === 'granted') {
      const folder = await planFolder(dir, siteName, planName, req.planId);
      const handle = await folder.getFileHandle(fileName, { create: true });
      const writable = await handle.createWritable();
      await writable.write(bytes);
      await writable.close();
      const settings = await loadBackupSettings(repo);
      const managed = (await listFiles(folder)).map(parseBackupFileName).filter((f) => f !== null);
      const toDelete = selectBackupsToDelete(managed, settings.policy);
      for (const name of toDelete) await folder.removeEntry(name);
      const entry: BackupLogEntry = {
        ...base,
        bytes: bytes.byteLength,
        destination: 'folder',
        ok: true,
        partial,
        deleted: toDelete.length,
      };
      await appendLog(entry, repo);
      return entry;
    }
    if (!req.allowDownload)
      throw new Error(
        dir
          ? 'Autorisation d’écrire dans le dossier de sauvegarde à renouveler.'
          : 'Aucun dossier de sauvegarde choisi.',
      );
    downloadBytes(bytes, fileName, 'application/octet-stream');
    const entry: BackupLogEntry = {
      ...base,
      bytes: bytes.byteLength,
      destination: 'download',
      ok: true,
      partial,
    };
    await appendLog(entry, repo);
    return entry;
  } catch (error) {
    const entry: BackupLogEntry = {
      ...base,
      bytes: 0,
      destination: dir ? 'folder' : 'download',
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
    logEvent('backup', error, { context: fileName });
    await appendLog(entry, repo);
    return entry;
  }
}

/** Plans modifiés depuis leur dernière sauvegarde externe réussie. */
export async function plansDue(repo: ProjectRepository = repository): Promise<string[]> {
  const log = await readBackupLog(repo);
  const last = new Map<string, string>();
  for (const e of log) if (e.ok) last.set(e.planId, e.at);
  const due: string[] = [];
  for (const site of await repo.listSites())
    for (const plan of await repo.listPlans(site.id)) {
      const at = last.get(plan.id);
      if (!at || plan.updatedAt > at) due.push(plan.id);
    }
  return due;
}

/** Sauvegarde les plans modifiés (dossier) ; en mode téléchargement, met à jour le rappel. */
export async function backupDuePlans(
  options: { allowDownload?: boolean } = {},
  repo: ProjectRepository = repository,
) {
  const store = useBackupStore.getState();
  if (store.running) return [];
  store.set({ running: true });
  try {
    const due = await plansDue(repo);
    const folder = await refreshFolderState(repo);
    if (folder !== 'granted' && !options.allowDownload) {
      useBackupStore.getState().set({ due });
      return [];
    }
    const results = [];
    for (const planId of due)
      results.push(await backupPlan({ planId, kind: 'quick', allowDownload: options.allowDownload }, repo));
    useBackupStore.getState().set({ due: await plansDue(repo) });
    return results;
  } finally {
    useBackupStore.getState().set({ running: false });
  }
}

// --- Planification (un seul onglet) ------------------------------------------------------------------

let timer: ReturnType<typeof setInterval> | undefined;

export async function startBackupScheduler(repo: ProjectRepository = repository): Promise<() => void> {
  const settings = await loadBackupSettings(repo);
  useBackupStore.getState().set({ settings, log: await readBackupLog(repo) });
  await refreshFolderState(repo);
  useBackupStore.getState().set({ due: await plansDue(repo) });
  let stopped = false;
  let release: () => void = () => undefined;
  const run = () => {
    const s = useBackupStore.getState().settings;
    if (!s.enabled || stopped) return;
    void backupDuePlans({}, repo).catch((error: unknown) => logEvent('backup', error));
  };
  const arm = () => {
    if (timer) clearInterval(timer);
    const minutes = useBackupStore.getState().settings.intervalMinutes;
    if (minutes > 0) timer = setInterval(run, minutes * 60_000);
  };
  const lead = () => {
    arm();
    const off = useBackupStore.subscribe((s, p) => {
      if (s.settings.intervalMinutes !== p.settings.intervalMinutes) arm();
    });
    return () => {
      off();
      if (timer) clearInterval(timer);
    };
  };
  // Un seul onglet planifie : les autres attendent (et prennent le relais s'il ferme).
  if (navigator.locks)
    void navigator.locks.request('campplanner-backup-scheduler', async () => {
      if (stopped) return;
      const off = lead();
      await new Promise<void>((resolve) => (release = resolve));
      off();
    });
  else release = lead();
  return () => {
    stopped = true;
    release();
  };
}

/** Déclencheur « à la fermeture » : sortie d'un plan, onglet masqué. */
export function backupOnClose(planId: string) {
  const s = useBackupStore.getState();
  if (!s.settings.enabled || !s.settings.onClose || s.folder !== 'granted') return;
  void (async () => {
    const last = await lastBackupOf(planId);
    const summary = await repository.getPlanSummary(planId);
    if (!summary || (last && summary.updatedAt <= last.at)) return;
    await backupPlan({ planId, kind: 'quick' });
  })().catch((error: unknown) => logEvent('backup', error));
}

/** Déclencheur « après une révision » (création ou approbation). */
export function backupAfterRevision(planId: string, label: string, approved: boolean) {
  const s = useBackupStore.getState();
  if (!s.settings.enabled || !s.settings.afterRevision) return;
  if (s.folder !== 'granted') {
    useBackupStore.getState().set({ due: [...new Set([...s.due, planId])] });
    return;
  }
  void backupPlan({ planId, kind: approved ? 'approved' : 'revision', label }).catch((error: unknown) =>
    logEvent('backup', error),
  );
}
