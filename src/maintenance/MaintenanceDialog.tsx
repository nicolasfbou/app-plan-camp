/**
 * « Santé et sauvegardes » : centre de santé du projet (vert / jaune / rouge, réparations
 * contrôlées), sauvegardes externes (dossier, politique, historique), nettoyage (espace affiché avant
 * suppression), journal local des erreurs, rapport de diagnostic, copie de secours.
 */
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  HardDriveDownload,
  LifeBuoy,
  Loader2,
  RefreshCw,
  X,
  XCircle,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { repository } from '@/app/repository.ts';
import { downloadBytes } from '@/app/download.ts';
import { saveNow } from '@/app/saveNow.ts';
import {
  backupDuePlans,
  backupPlan,
  chooseBackupFolder,
  lastBackupOf,
  regrantBackupFolder,
  saveBackupSettings,
  supportsFolderBackups,
  useBackupStore,
  type BackupSettings,
} from '@/backups/backupService.ts';
import { applyCleanup, type CleanupItem, type CleanupResult, planCleanup } from '@/diagnostics/cleanup.ts';
import { buildDiagnostic } from '@/diagnostics/diagnostic.ts';
import { clearErrorLog, logEvent, readErrorLog, subscribeErrorLog } from '@/diagnostics/errorLog.ts';
import {
  applyRepair,
  type HealthCheck,
  type RepairId,
  runPlanHealth,
  worstStatus,
} from '@/diagnostics/health.ts';
import { useSessionStore } from '@/editor/session/sessionStore.ts';
import { formatDateTime, t } from '@/i18n/index.ts';
import { downloadEmergencyCopy } from './emergencyDownload.ts';
import { Button } from '@/ui/Button.tsx';
import { Modal } from '@/ui/Modal.tsx';

export type MaintenanceTab = 'health' | 'backups' | 'cleanup' | 'journal' | 'diagnostic';

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(bytes < 1024 * 1024 ? 2 : 1)} Mo`;

const STATUS_STYLE = {
  ok: { icon: CheckCircle2, className: 'text-emerald-700', label: 'OK' },
  warn: { icon: AlertTriangle, className: 'text-amber-600', label: 'Attention' },
  error: { icon: XCircle, className: 'text-red-700', label: 'Problème' },
} as const;

const IGNORED_KEY = (planId: string) => `campplanner.health.ignored.${planId}`;
function readIgnored(planId: string): string[] {
  try {
    return JSON.parse(localStorage.getItem(IGNORED_KEY(planId)) ?? '[]') as string[];
  } catch {
    return [];
  }
}

export function MaintenanceDialog({
  planId,
  initialTab,
  onClose,
}: {
  planId: string | null;
  initialTab?: MaintenanceTab;
  onClose(): void;
}) {
  const [tab, setTab] = useState<MaintenanceTab>(initialTab ?? (planId ? 'health' : 'backups'));
  const tabs: { id: MaintenanceTab; label: string }[] = [
    ...(planId ? [{ id: 'health' as const, label: t('maint.tab.health') }] : []),
    { id: 'backups', label: t('maint.tab.backups') },
    { id: 'cleanup', label: t('maint.tab.cleanup') },
    { id: 'journal', label: t('maint.tab.journal') },
    { id: 'diagnostic', label: t('maint.tab.diagnostic') },
  ];
  return (
    <Modal
      open
      wide
      title={t('maint.title')}
      onClose={onClose}
      footer={<Button onClick={onClose}>{t('common.close')}</Button>}
    >
      <div data-testid="maintenance-dialog">
        <div role="tablist" className="mb-3 flex flex-wrap gap-1 border-b border-slate-200">
          {tabs.map((x) => (
            <button
              key={x.id}
              type="button"
              role="tab"
              aria-selected={tab === x.id}
              onClick={() => setTab(x.id)}
              className={`px-3 py-1.5 text-sm font-medium ${tab === x.id ? 'border-b-2 border-accent text-accent' : 'text-slate-600 hover:text-slate-900'}`}
            >
              {x.label}
            </button>
          ))}
        </div>
        {tab === 'health' && planId && <HealthTab planId={planId} />}
        {tab === 'backups' && <BackupsTab planId={planId} />}
        {tab === 'cleanup' && <CleanupTab />}
        {tab === 'journal' && <JournalTab />}
        {tab === 'diagnostic' && <DiagnosticTab planId={planId} />}
      </div>
    </Modal>
  );
}

// --- Santé -----------------------------------------------------------------------------------------

function HealthTab({ planId }: { planId: string }) {
  const [checks, setChecks] = useState<HealthCheck[] | null>(null);
  const [running, setRunning] = useState(false);
  const [ignored, setIgnored] = useState(() => readIgnored(planId));
  const [confirm, setConfirm] = useState<HealthCheck | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [emergency, setEmergency] = useState<string | null>(null);
  const lockMode = useSessionStore((s) => (s.planId === planId ? s.lockMode : 'pending'));
  const settings = useBackupStore((s) => s.settings);

  const run = useCallback(async () => {
    setRunning(true);
    try {
      const last = await lastBackupOf(planId);
      setChecks(
        await runPlanHealth(repository, planId, {
          lastBackupAt: last?.at ?? null,
          backupIntervalMinutes: settings.intervalMinutes,
          lockMode,
        }),
      );
    } finally {
      setRunning(false);
    }
  }, [planId, settings.intervalMinutes, lockMode]);
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void run();
  }, [run]);

  const toggleIgnore = (id: string) => {
    const next = ignored.includes(id) ? ignored.filter((x) => x !== id) : [...ignored, id];
    setIgnored(next);
    try {
      localStorage.setItem(IGNORED_KEY(planId), JSON.stringify(next));
    } catch {
      // préférence de confort
    }
  };
  const repair = async (check: HealthCheck, withBackup: boolean) => {
    setConfirm(null);
    try {
      if (withBackup) await downloadEmergencyCopy(planId);
      const result = await applyRepair(repository, planId, check.repair as RepairId);
      logEvent('repair', result, { level: 'info', context: check.label });
      setMessage(result);
    } catch (error) {
      logEvent('repair', error, { context: check.label });
      setMessage(error instanceof Error ? error.message : String(error));
    }
    await run();
  };
  const overall = checks ? worstStatus(checks) : null;

  return (
    <div className="space-y-3" data-testid="health-tab">
      <div className="flex flex-wrap items-center gap-2">
        {overall && (
          <span
            className={`flex items-center gap-1 font-semibold ${STATUS_STYLE[overall].className}`}
            data-testid="health-overall"
            data-status={overall}
          >
            {(() => {
              const Icon = STATUS_STYLE[overall].icon;
              return <Icon size={18} aria-hidden />;
            })()}
            {t(`maint.health.${overall}`)}
          </span>
        )}
        <div className="flex-1" />
        <Button onClick={() => void run()} disabled={running} data-testid="health-rerun">
          {running ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}{' '}
          {t('maint.health.rerun')}
        </Button>
        <Button
          variant="primary"
          data-testid="emergency-export"
          onClick={() =>
            void downloadEmergencyCopy(planId).then(
              (r) =>
                setEmergency(
                  r.complete
                    ? t('maint.emergency.complete', { file: r.fileName })
                    : t('maint.emergency.partial', { file: r.fileName, list: r.problems.join(' ; ') }),
                ),
              (e: unknown) => setEmergency(e instanceof Error ? e.message : String(e)),
            )
          }
        >
          <LifeBuoy size={16} /> {t('maint.emergency')}
        </Button>
      </div>
      {emergency && (
        <p role="status" className="rounded-md bg-slate-50 p-2 text-sm" data-testid="emergency-result">
          {emergency}
        </p>
      )}
      {!checks && <p role="status">{t('maint.health.running')}</p>}
      <ul className="divide-y divide-slate-100" data-testid="health-checks">
        {checks?.map((c) => {
          const style = STATUS_STYLE[c.status];
          const Icon = style.icon;
          const isIgnored = ignored.includes(c.id) && c.status !== 'ok';
          return (
            <li key={c.id} className="flex items-start gap-2 py-2" data-check={c.id} data-status={c.status}>
              <Icon size={18} className={`mt-0.5 shrink-0 ${style.className}`} aria-label={style.label} />
              <div className="min-w-0 flex-1">
                <p className="font-medium text-slate-900">
                  {c.label}
                  {isIgnored && (
                    <span className="ml-2 rounded bg-slate-100 px-1.5 text-xs font-normal text-slate-600">
                      {t('maint.health.ignored')}
                    </span>
                  )}
                </p>
                <p className="text-sm break-words text-slate-600">{c.detail}</p>
              </div>
              {c.status !== 'ok' && (
                <div className="flex shrink-0 gap-1">
                  {c.repair && (
                    <Button
                      className="px-2 py-1 text-xs"
                      onClick={() => setConfirm(c)}
                      data-testid={`repair-${c.id}`}
                    >
                      {t('maint.health.repair')}
                    </Button>
                  )}
                  <Button variant="ghost" className="px-2 py-1 text-xs" onClick={() => toggleIgnore(c.id)}>
                    {isIgnored ? t('maint.health.unignore') : t('maint.health.ignore')}
                  </Button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {message && (
        <p role="status" className="text-sm text-emerald-800" data-testid="repair-result">
          {message}
        </p>
      )}
      <p className="text-xs text-slate-500">{t('maint.health.note')}</p>
      {confirm && (
        <Modal
          open
          title={t('maint.repair.title', { label: confirm.label })}
          onClose={() => setConfirm(null)}
          footer={
            <>
              <Button onClick={() => setConfirm(null)}>{t('common.cancel')}</Button>
              <Button onClick={() => void repair(confirm, false)} data-testid="repair-without-backup">
                {t('maint.repair.now')}
              </Button>
              <Button
                variant="primary"
                onClick={() => void repair(confirm, true)}
                data-testid="repair-with-backup"
              >
                {t('maint.repair.backupFirst')}
              </Button>
            </>
          }
        >
          <p>{confirm.detail}</p>
          <p className="mt-2 text-slate-600">{t('maint.repair.body')}</p>
        </Modal>
      )}
    </div>
  );
}

// --- Sauvegardes ---------------------------------------------------------------------------------

function BackupsTab({ planId }: { planId: string | null }) {
  const { settings, folder, folderName, log, due, running } = useBackupStore();
  const [message, setMessage] = useState<string | null>(null);
  const update = (patch: Partial<BackupSettings>) => void saveBackupSettings({ ...settings, ...patch });
  const policy = (patch: Partial<BackupSettings['policy']>) =>
    update({ policy: { ...settings.policy, ...patch } });
  const act = (fn: () => Promise<string>) =>
    void fn().then(setMessage, (e: unknown) => setMessage(e instanceof Error ? e.message : String(e)));
  const num = (label: string, value: number, onChange: (v: number) => void, testId: string) => (
    <label className="flex items-center justify-between gap-2 text-sm">
      {label}
      <input
        type="number"
        min={0}
        max={365}
        value={value}
        onChange={(e) => onChange(Math.max(0, Number(e.target.value) || 0))}
        className="w-20 rounded border border-slate-300 px-2 py-1"
        data-testid={testId}
      />
    </label>
  );

  return (
    <div className="space-y-4" data-testid="backups-tab">
      <section className="rounded-md border border-slate-200 p-3">
        <h3 className="font-semibold text-slate-900">{t('maint.backup.destination')}</h3>
        <p className="mt-1 text-sm text-slate-700" data-testid="backup-folder-state">
          {folder === 'unsupported'
            ? t('maint.backup.unsupported')
            : folder === 'none'
              ? t('maint.backup.noFolder')
              : folder === 'needs-permission'
                ? t('maint.backup.needsPermission', { name: folderName ?? '' })
                : t('maint.backup.folder', { name: folderName ?? '' })}
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          {supportsFolderBackups() && (
            <Button
              onClick={() => act(async () => (await chooseBackupFolder(), t('maint.backup.folderChosen')))}
              data-testid="backup-choose-folder"
            >
              {t('maint.backup.choose')}
            </Button>
          )}
          {folder === 'needs-permission' && (
            <Button
              variant="primary"
              onClick={() =>
                act(async () =>
                  (await regrantBackupFolder()) ? t('maint.backup.granted') : t('maint.backup.denied'),
                )
              }
            >
              {t('maint.backup.grant')}
            </Button>
          )}
          <Button
            variant="primary"
            disabled={running}
            data-testid="backup-now"
            onClick={() =>
              act(async () => {
                await saveNow().catch(() => undefined);
                const results = await backupDuePlans({ allowDownload: folder !== 'granted' });
                return results.length
                  ? t('maint.backup.done', { count: results.filter((r) => r.ok).length })
                  : t('maint.backup.nothing');
              })
            }
          >
            <HardDriveDownload size={16} /> {t('maint.backup.now', { count: due.length })}
          </Button>
          {planId && (
            <Button
              data-testid="backup-this-plan"
              onClick={() =>
                act(async () => {
                  await saveNow().catch(() => undefined);
                  const r = await backupPlan({ planId, kind: 'quick', allowDownload: true });
                  return r.ok ? t('maint.backup.one', { file: r.fileName }) : (r.error ?? '');
                })
              }
            >
              <Download size={16} /> {t('maint.backup.thisPlan')}
            </Button>
          )}
        </div>
        {message && (
          <p role="status" className="mt-2 text-sm text-slate-800" data-testid="backup-message">
            {message}
          </p>
        )}
      </section>

      <section className="grid grid-cols-2 gap-x-6 gap-y-2 rounded-md border border-slate-200 p-3">
        <h3 className="col-span-2 font-semibold text-slate-900">{t('maint.backup.triggers')}</h3>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={settings.enabled}
            onChange={(e) => update({ enabled: e.target.checked })}
            data-testid="backup-enabled"
          />
          {t('maint.backup.enabled')}
        </label>
        <label className="flex items-center justify-between gap-2 text-sm">
          {t('maint.backup.interval')}
          <select
            value={settings.intervalMinutes}
            onChange={(e) =>
              update({ intervalMinutes: Number(e.target.value) as BackupSettings['intervalMinutes'] })
            }
            className="rounded border border-slate-300 px-2 py-1"
            data-testid="backup-interval"
          >
            <option value={15}>{t('maint.backup.every15')}</option>
            <option value={60}>{t('maint.backup.hourly')}</option>
            <option value={0}>{t('maint.backup.noInterval')}</option>
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={settings.onClose}
            onChange={(e) => update({ onClose: e.target.checked })}
          />
          {t('maint.backup.onClose')}
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={settings.afterRevision}
            onChange={(e) => update({ afterRevision: e.target.checked })}
          />
          {t('maint.backup.afterRevision')}
        </label>
        <h3 className="col-span-2 mt-2 font-semibold text-slate-900">{t('maint.backup.policy')}</h3>
        {num(t('maint.backup.quick'), settings.policy.quick, (v) => policy({ quick: v }), 'policy-quick')}
        {num(t('maint.backup.daily'), settings.policy.daily, (v) => policy({ daily: v }), 'policy-daily')}
        {num(t('maint.backup.weekly'), settings.policy.weekly, (v) => policy({ weekly: v }), 'policy-weekly')}
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={settings.policy.keepApproved}
            onChange={(e) => policy({ keepApproved: e.target.checked })}
          />
          {t('maint.backup.keepApproved')}
        </label>
      </section>

      <section>
        <h3 className="font-semibold text-slate-900">{t('maint.backup.history')}</h3>
        <ul className="mt-1 max-h-48 space-y-0.5 overflow-y-auto text-xs" data-testid="backup-history">
          {log.length === 0 && <li className="text-slate-500">{t('maint.backup.noHistory')}</li>}
          {[...log]
            .reverse()
            .slice(0, 30)
            .map((e, i) => (
              <li key={i} className={e.ok ? 'text-slate-700' : 'text-red-700'}>
                {formatDateTime(e.at)} — {e.fileName} —{' '}
                {e.ok
                  ? `${mb(e.bytes)}, ${e.destination === 'folder' ? t('maint.backup.toFolder') : t('maint.backup.toDownload')}${e.partial ? ` (${t('maint.backup.partial')})` : ''}${e.deleted ? `, ${t('maint.backup.rotated', { count: e.deleted })}` : ''}`
                  : `${t('maint.backup.failed')} : ${e.error}`}
              </li>
            ))}
        </ul>
      </section>
    </div>
  );
}

// --- Nettoyage ------------------------------------------------------------------------------------

function CleanupTab() {
  const [items, setItems] = useState<CleanupItem[] | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [results, setResults] = useState<CleanupResult[] | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const analyse = async () => {
    setBusy(true);
    setResults(null);
    try {
      const list = await planCleanup(repository);
      setItems(list);
      setSelected(new Set(list.map((_, i) => i)));
    } finally {
      setBusy(false);
    }
  };
  const total = items ? items.filter((_, i) => selected.has(i)).reduce((s, x) => s + x.bytes, 0) : 0;
  const apply = async () => {
    setConfirming(false);
    setBusy(true);
    try {
      const r = await applyCleanup(
        repository,
        items!.filter((_, i) => selected.has(i)),
      );
      setResults(r);
      logEvent(
        'repair',
        `Nettoyage : ${r.reduce((s, x) => s + x.done, 0)} élément(s), ${mb(r.reduce((s, x) => s + x.bytes, 0))}`,
        { level: 'info' },
      );
      setItems(await planCleanup(repository));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-3" data-testid="cleanup-tab">
      <p className="text-sm text-slate-700">{t('maint.cleanup.intro')}</p>
      <Button onClick={() => void analyse()} disabled={busy} data-testid="cleanup-analyse">
        {busy ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}{' '}
        {t('maint.cleanup.analyse')}
      </Button>
      {items && !items.length && (
        <p className="text-emerald-700" data-testid="cleanup-empty">
          {t('maint.cleanup.nothing')}
        </p>
      )}
      {items && items.length > 0 && (
        <>
          <ul className="space-y-1" data-testid="cleanup-items">
            {items.map((item, i) => (
              <li key={item.kind}>
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={selected.has(i)}
                    onChange={() =>
                      setSelected((s) => {
                        const n = new Set(s);
                        if (n.has(i)) n.delete(i);
                        else n.add(i);
                        return n;
                      })
                    }
                  />
                  <span>
                    {item.label} — {item.count} ·{' '}
                    <strong>
                      {item.estimated ? '≈ ' : ''}
                      {mb(item.bytes)}
                    </strong>
                  </span>
                </label>
              </li>
            ))}
          </ul>
          <p className="text-sm font-medium" data-testid="cleanup-total">
            {t('maint.cleanup.total', { size: mb(total) })}
          </p>
          <Button
            variant="danger"
            disabled={busy || !selected.size}
            onClick={() => setConfirming(true)}
            data-testid="cleanup-apply"
          >
            {t('maint.cleanup.apply')}
          </Button>
        </>
      )}
      {results && (
        <ul className="text-sm text-slate-700" data-testid="cleanup-results">
          {results.map((r) => (
            <li key={r.kind}>
              {r.kind} : {r.done} — {mb(r.bytes)}
              {r.skipped.length ? ` — ${t('maint.cleanup.skipped')} : ${r.skipped.join(' ; ')}` : ''}
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-slate-500">{t('maint.cleanup.never')}</p>
      {confirming && (
        <Modal
          open
          title={t('maint.cleanup.confirmTitle')}
          onClose={() => setConfirming(false)}
          footer={
            <>
              <Button onClick={() => setConfirming(false)}>{t('common.cancel')}</Button>
              <Button variant="danger" onClick={() => void apply()} data-testid="cleanup-confirm">
                {t('maint.cleanup.confirm', { size: mb(total) })}
              </Button>
            </>
          }
        >
          <p>{t('maint.cleanup.confirmBody', { size: mb(total) })}</p>
        </Modal>
      )}
    </div>
  );
}

// --- Journal ----------------------------------------------------------------------------------------

function JournalTab() {
  const entries = useSyncExternalStore(subscribeErrorLog, () => JSON.stringify(readErrorLog()));
  const list = (JSON.parse(entries) as ReturnType<typeof readErrorLog>).reverse();
  const [confirm, setConfirm] = useState(false);
  return (
    <div className="space-y-2" data-testid="journal-tab">
      <div className="flex items-center gap-2">
        <p className="flex-1 text-sm text-slate-700">{t('maint.journal.intro', { count: list.length })}</p>
        <Button
          variant="ghost"
          disabled={!list.length}
          onClick={() => setConfirm(true)}
          data-testid="journal-clear"
        >
          {t('maint.journal.clear')}
        </Button>
      </div>
      <ul className="max-h-80 space-y-1 overflow-y-auto text-xs" data-testid="journal-list">
        {list.length === 0 && <li className="text-slate-500">{t('maint.journal.empty')}</li>}
        {list.map((e, i) => (
          <li
            key={i}
            className={
              e.level === 'error' ? 'text-red-800' : e.level === 'warn' ? 'text-amber-800' : 'text-slate-700'
            }
          >
            <span className="text-slate-500">{formatDateTime(e.at)}</span> — <strong>{e.category}</strong> —{' '}
            {e.message}
            {e.context ? ` (${e.context})` : ''}
          </li>
        ))}
      </ul>
      {confirm && (
        <Modal
          open
          title={t('maint.journal.clear')}
          onClose={() => setConfirm(false)}
          footer={
            <>
              <Button onClick={() => setConfirm(false)}>{t('common.cancel')}</Button>
              <Button
                variant="danger"
                onClick={() => {
                  clearErrorLog();
                  setConfirm(false);
                }}
                data-testid="journal-clear-confirm"
              >
                {t('maint.journal.clear')}
              </Button>
            </>
          }
        >
          <p>{t('maint.journal.clearBody')}</p>
        </Modal>
      )}
    </div>
  );
}

// --- Diagnostic ------------------------------------------------------------------------------------

function DiagnosticTab({ planId }: { planId: string | null }) {
  const [includeNames, setIncludeNames] = useState(false);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const lockMode = useSessionStore((s) => s.lockMode);
  const { folder, folderName, settings } = useBackupStore();
  const run = async () => {
    setBusy(true);
    try {
      const last = planId ? await lastBackupOf(planId) : null;
      const health = planId
        ? await runPlanHealth(repository, planId, {
            lastBackupAt: last?.at ?? null,
            backupIntervalMinutes: settings.intervalMinutes,
            lockMode,
          })
        : undefined;
      const report = await buildDiagnostic(repository, {
        planId,
        health,
        includeNames,
        lockMode,
        backup: {
          folder: folder === 'granted' ? `dossier « ${includeNames ? folderName : '…'} »` : folder,
          lastAt: last?.at ?? null,
          intervalMinutes: settings.intervalMinutes,
        },
      });
      const text = JSON.stringify(report, null, 2);
      setPreview(text);
      downloadBytes(
        new TextEncoder().encode(text),
        `diagnostic-campplanner-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.json`,
        'application/json',
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-3" data-testid="diagnostic-tab">
      <p className="text-sm text-slate-700">{t('maint.diag.intro')}</p>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={includeNames} onChange={(e) => setIncludeNames(e.target.checked)} />
        {t('maint.diag.names')}
      </label>
      <Button variant="primary" onClick={() => void run()} disabled={busy} data-testid="diagnostic-export">
        {busy ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />}{' '}
        {t('maint.diag.export')}
      </Button>
      {preview && (
        <pre
          className="max-h-64 overflow-auto rounded bg-slate-50 p-2 text-xs"
          data-testid="diagnostic-preview"
        >
          {preview}
        </pre>
      )}
    </div>
  );
}

/** Rappel global : sauvegarde externe en attente d'autorisation ou de téléchargement. */
export function BackupReminder({ onOpen }: { onOpen(): void }) {
  const { folder, due, settings } = useBackupStore();
  const [dismissed, setDismissed] = useState(false);
  if (dismissed || !settings.enabled || !due.length || folder === 'granted') return null;
  return (
    <div
      role="status"
      data-testid="backup-reminder"
      className="fixed right-4 bottom-4 z-40 flex max-w-md items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 shadow-lg"
    >
      <HardDriveDownload size={18} className="mt-0.5 shrink-0" aria-hidden />
      <div className="flex-1">
        <p>
          {folder === 'needs-permission'
            ? t('maint.reminder.permission', { count: due.length })
            : t('maint.reminder.due', { count: due.length })}
        </p>
        <div className="mt-2 flex gap-2">
          {folder === 'needs-permission' ? (
            <Button variant="primary" onClick={() => void regrantBackupFolder().then(() => backupDuePlans())}>
              {t('maint.backup.grant')}
            </Button>
          ) : (
            <Button
              variant="primary"
              onClick={() => void backupDuePlans({ allowDownload: true })}
              data-testid="reminder-download"
            >
              {t('maint.reminder.download')}
            </Button>
          )}
          <Button onClick={onOpen}>{t('maint.reminder.settings')}</Button>
        </div>
      </div>
      <button
        type="button"
        aria-label={t('common.close')}
        onClick={() => setDismissed(true)}
        className="text-amber-800"
      >
        <X size={16} />
      </button>
    </div>
  );
}
