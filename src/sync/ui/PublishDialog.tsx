/**
 * Publication d'un camp local dans l'organisation : vérification et récapitulatif (plans,
 * révisions, fichiers, taille, SHA-256, approbations locales non vérifiées, conflits possibles),
 * confirmation explicite, puis envoi.
 */
import { useEffect, useState } from 'react';
import { readProfiles, setActiveProfile, type Profile } from '@/app/profile.ts';
import { repository } from '@/app/repository.ts';
import { t } from '@/i18n/index.ts';
import { Button } from '@/ui/Button.tsx';
import { Modal } from '@/ui/Modal.tsx';
import { useSubmit } from '@/ui/useSubmit.ts';
import { api } from '../api.ts';
import { checkPublication, publishCamp, type PublishCheck, sessionProfile } from '../publish.ts';

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} Mo`;

export function PublishDialog({ campId, onClose }: { campId: string; onClose(): void }) {
  const [target, setTarget] = useState<Profile | null | undefined>(undefined);
  const [check, setCheck] = useState<PublishCheck | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [finished, setFinished] = useState<{ pending: number } | null>(null);
  const { busy, error, submit } = useSubmit();

  useEffect(() => {
    void (async () => {
      const profile = await sessionProfile(api, readProfiles());
      setTarget(profile);
      if (!profile) return;
      try {
        setCheck(await checkPublication(repository, api, campId));
      } catch (e) {
        setCheckError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [campId]);

  const org = target?.orgName ?? '';
  const blocked = !check || check.conflicts.length > 0;
  return (
    <Modal
      open
      wide
      title={t('publish.title', { camp: check?.campName ?? '', org })}
      onClose={onClose}
      footer={
        finished ? (
          <>
            <Button onClick={onClose}>{t('common.close')}</Button>
            <Button
              variant="primary"
              onClick={() => {
                setActiveProfile(target!.id);
                window.location.hash = '#/';
                window.location.reload();
              }}
            >
              {t('publish.openSpace', { org })}
            </Button>
          </>
        ) : (
          <>
            <Button onClick={onClose}>{t('common.cancel')}</Button>
            <Button
              variant="primary"
              data-testid="publish-confirm"
              disabled={busy || blocked || !target}
              onClick={() =>
                void submit(async () => {
                  setFinished(
                    await publishCamp(repository, api, target!, campId, (done, total) =>
                      setProgress({ done, total }),
                    ),
                  );
                })
              }
            >
              {t('publish.confirm')}
            </Button>
          </>
        )
      }
    >
      <div className="space-y-3 text-sm" data-testid="publish-dialog">
        {target === null && (
          <p className="rounded bg-amber-50 p-2 text-amber-900">{t('publish.needSession')}</p>
        )}
        {target && !check && !checkError && <p>{t('publish.checking')}</p>}
        {checkError && (
          <p role="alert" className="text-red-700">
            {checkError}
          </p>
        )}
        {check && (
          <div data-testid="publish-summary" className="space-y-1">
            <h3 className="font-semibold">{t('publish.summary')}</h3>
            <p>
              {t('publish.plans', { count: check.plans.length })} —{' '}
              {check.plans.map((p) => p.name).join(', ')}
            </p>
            <p>{t('publish.revisions', { count: check.revisions })}</p>
            <p>
              {t('publish.files', {
                count: check.files.length,
                size: mb(check.totalBytes),
                present: check.presentFiles,
              })}
            </p>
            <ul
              className="max-h-24 overflow-y-auto font-mono text-[11px] text-slate-600"
              data-testid="publish-shas"
            >
              {check.files.map((f) => (
                <li key={f.sha256}>SHA-256 {f.sha256}</li>
              ))}
            </ul>
            {check.unverifiedApprovals > 0 && (
              <p className="text-amber-800" data-testid="publish-unverified">
                {t('publish.unverified', { count: check.unverifiedApprovals })}
              </p>
            )}
            {check.conflicts.length > 0 && (
              <p className="text-red-700" data-testid="publish-conflicts">
                {t('publish.conflicts', { list: check.conflicts.join(', ') })}
              </p>
            )}
            {check.problems.length > 0 && (
              <p className="text-red-700">{t('publish.health', { list: check.problems.join(' ; ') })}</p>
            )}
          </div>
        )}
        {progress && !finished && <p>{t('publish.progress', progress)}</p>}
        {finished && (
          <p className="rounded bg-emerald-50 p-2 text-emerald-900" data-testid="publish-done">
            {t('publish.done', { org })}
            {finished.pending
              ? ` (${finished.pending} opération(s) encore en file : elles partiront à la prochaine synchronisation.)`
              : ''}
          </p>
        )}
        {error && (
          <p role="alert" className="text-red-700">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
