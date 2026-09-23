/**
 * Lisibilité du plan imprimé (vue et format affichés) : chevauchements, textes coupés ou trop
 * petits, débordements. Chaque problème peut être montré (sélection + zoom), marqué vérifié ou
 * ignoré volontairement. Pour une étiquette, un emplacement plus lisible peut être PROPOSÉ :
 * l'utilisateur l'accepte ou le refuse, rien n'est jamais déplacé automatiquement.
 */
import { CheckCircle2, Crosshair, EyeOff, MapPin, RotateCcw, Wand2, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { applyLabelPlacement, setReadabilityReview } from '@/domain/print/readabilityReviews.ts';
import { effectiveSettings } from '@/domain/print/views.ts';
import { viewportActions } from '@/editor/viewportActions.ts';
import { CANVAS_FONT_STACK, loadExportFonts } from '@/export/fonts.ts';
import { MM_PER_PT } from '@/export/painter.ts';
import {
  analyzeReadability,
  proposeLabelPlacement,
  type Measure,
  type ReadabilityIssue,
  type ReadabilityReport,
} from '@/export/readability.ts';
import { t } from '@/i18n/index.ts';
import { useEditorStore } from '@/store/editorStore.ts';
import { planStore, usePlanStore } from '@/store/planStore.ts';
import { Button } from '@/ui/Button.tsx';
import { Section, Toggle } from './fields.tsx';

/** Mesure du texte avec la police des exports (mêmes largeurs que le PDF), en mm. */
function canvasMeasure(): Measure {
  const c = document.createElement('canvas').getContext('2d')!;
  return (text, pt, bold) => {
    c.font = `${bold ? 700 : 400} ${pt * MM_PER_PT * 10}px ${CANVAS_FONT_STACK}`;
    return c.measureText(text).width / 10;
  };
}

const STATUS_CLASS: Record<ReadabilityIssue['status'], string> = {
  open: 'bg-amber-100 text-amber-900',
  verified: 'bg-emerald-100 text-emerald-800',
  ignored: 'bg-slate-200 text-slate-700',
};

export function ReadabilityPanel() {
  const doc = usePlanStore((s) => s.doc);
  const viewId = useEditorStore((s) => s.activeViewId);
  const proposal = useEditorStore((s) => s.labelProposal);
  const [report, setReport] = useState<ReadabilityReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showClosed, setShowClosed] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Analyse relancée (après une courte pause) à chaque modification du plan ou de la vue.
  useEffect(() => {
    if (!doc) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      loadExportFonts()
        .catch(() => undefined) // sans la police : largeurs d'une police aux mêmes métriques
        .then(() => {
          if (cancelled) return;
          setReport(analyzeReadability(doc, effectiveSettings(doc, viewId), canvasMeasure()));
          setError(null);
        })
        .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [doc, viewId]);

  // Une proposition ne survit pas à un changement de vue.
  useEffect(() => () => useEditorStore.getState().setLabelProposal(null), [viewId]);

  const listed = useMemo(
    () => report?.issues.filter((i) => showClosed || i.status === 'open') ?? [],
    [report, showClosed],
  );
  if (!doc) return null;
  const settings = effectiveSettings(doc, viewId);

  const show = (issue: ReadabilityIssue) => {
    setSelectedKey(issue.key);
    const ids = issue.objectIds.filter((id) => doc.objects[id]);
    useEditorStore.getState().select(ids);
    if (issue.bounds) viewportActions.zoomToBox(issue.bounds);
  };
  const review = (issue: ReadabilityIssue, status: 'verified' | 'ignored' | null) =>
    planStore
      .getState()
      .update(
        status === 'verified'
          ? 'Lisibilité vérifiée'
          : status === 'ignored'
            ? 'Lisibilité ignorée'
            : 'Rouvrir',
        (d) => setReadabilityReview(d, issue.key, status),
      );
  const propose = (issue: ReadabilityIssue) => {
    if (!report || !issue.movable) return;
    show(issue);
    const p = proposeLabelPlacement(doc, report, issue.movable.objectId, settings);
    if (!p) {
      useEditorStore.getState().setLabelProposal(null);
      setNotice(t('readability.noBetter'));
      return;
    }
    setNotice(p.remainingOverlap > 0 ? t('readability.partial') : null);
    useEditorStore.getState().setLabelProposal(p);
    viewportActions.zoomToBox({
      x: Math.min(p.at.x - p.width / 2, p.leaderTo?.x ?? Infinity),
      y: Math.min(p.at.y - p.height / 2, p.leaderTo?.y ?? Infinity),
      width: p.width + Math.abs((p.leaderTo?.x ?? p.at.x) - p.at.x),
      height: p.height + Math.abs((p.leaderTo?.y ?? p.at.y) - p.at.y),
    });
  };
  const accept = () => {
    if (!proposal) return;
    let ok = false;
    planStore.getState().update('Déplacer l’étiquette (proposition acceptée)', (d) => {
      ok = applyLabelPlacement(d, proposal);
    });
    useEditorStore.getState().setLabelProposal(null);
    setNotice(ok ? t('readability.accepted') : t('readability.locked'));
  };
  const refuse = () => {
    useEditorStore.getState().setLabelProposal(null);
    setNotice(t('readability.refused'));
  };

  const closed = (report?.issues.length ?? 0) - (report?.open ?? 0);
  return (
    <Section title={t('readability.title')}>
      <p className="text-xs text-slate-600">{t('readability.scope', { view: settings.name })}</p>
      {error && <p className="text-xs text-red-700">{error}</p>}
      {!report ? (
        <p className="text-xs text-slate-500">{t('readability.analyzing')}</p>
      ) : (
        <p
          className={`text-sm font-medium ${report.open ? 'text-amber-800' : 'text-emerald-800'}`}
          data-testid="readability-count"
        >
          {report.open ? t('readability.open', { count: report.open }) : t('readability.none')}
          {closed > 0 && (
            <span className="font-normal text-slate-500"> {t('readability.closed', { count: closed })}</span>
          )}
        </p>
      )}
      <Toggle label={t('readability.showClosed')} checked={showClosed} onChange={setShowClosed} />
      {proposal && (
        <div
          className="space-y-2 rounded-md border border-emerald-300 bg-emerald-50 p-2"
          data-testid="label-proposal"
        >
          <p className="text-xs text-emerald-900">
            {t(proposal.leaderTo ? 'readability.proposalLeader' : 'readability.proposal')}
          </p>
          <div className="flex gap-2">
            <Button variant="primary" className="flex-1" onClick={accept} data-testid="proposal-accept">
              <CheckCircle2 size={16} /> {t('readability.accept')}
            </Button>
            <Button className="flex-1" onClick={refuse} data-testid="proposal-refuse">
              <X size={16} /> {t('readability.refuse')}
            </Button>
          </div>
        </div>
      )}
      {notice && (
        <p className="text-xs text-slate-600" role="status">
          {notice}
        </p>
      )}
      <ul className="space-y-2" data-testid="readability-list">
        {listed.map((issue) => (
          <li
            key={issue.key}
            data-issue-kind={issue.kind}
            data-issue-status={issue.status}
            className={`rounded-md border p-2 text-xs ${selectedKey === issue.key ? 'border-accent' : 'border-slate-200'}`}
          >
            <div className="flex items-start gap-2">
              <span
                className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold ${STATUS_CLASS[issue.status]}`}
              >
                {t(`readability.status.${issue.status}`)}
              </span>
              <span className="min-w-0 flex-1 text-slate-800">{issue.message}</span>
            </div>
            <div className="mt-1.5 flex flex-wrap gap-1">
              {(issue.bounds || issue.objectIds.length > 0) && (
                <Button
                  className="px-2 py-1 text-xs"
                  onClick={() => show(issue)}
                  title={t('readability.show')}
                >
                  <Crosshair size={14} /> {t('readability.show')}
                </Button>
              )}
              {issue.movable && issue.status === 'open' && (
                <Button className="px-2 py-1 text-xs" onClick={() => propose(issue)} data-testid="propose">
                  <Wand2 size={14} /> {t('readability.propose')}
                </Button>
              )}
              {issue.status === 'open' ? (
                <>
                  <Button
                    className="px-2 py-1 text-xs"
                    onClick={() => review(issue, 'verified')}
                    data-testid="mark-verified"
                  >
                    <MapPin size={14} /> {t('readability.verify')}
                  </Button>
                  <Button
                    className="px-2 py-1 text-xs"
                    onClick={() => review(issue, 'ignored')}
                    data-testid="mark-ignored"
                  >
                    <EyeOff size={14} /> {t('readability.ignore')}
                  </Button>
                </>
              ) : (
                <Button className="px-2 py-1 text-xs" onClick={() => review(issue, null)}>
                  <RotateCcw size={14} /> {t('readability.reopen')}
                </Button>
              )}
            </div>
          </li>
        ))}
      </ul>
      <p className="text-xs text-slate-500">{t('readability.help')}</p>
    </Section>
  );
}
