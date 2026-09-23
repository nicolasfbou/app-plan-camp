/**
 * « Créer une variante à partir de ce plan » (ex. Circulation été → Circulation hiver) : tout est
 * copié au départ, puis les deux plans sont indépendants (pas encore d'objets partagés).
 */
import { useState } from 'react';
import { createVariant } from '@/domain/model/factories.ts';
import { PLAN_KINDS } from '@/domain/model/schema.ts';
import type { PlanKind } from '@/domain/model/types.ts';
import { t } from '@/i18n/index.ts';
import { Button } from '@/ui/Button.tsx';
import { Modal } from '@/ui/Modal.tsx';
import { repository } from './repository.ts';

/** Type proposé pour la variante : l'autre saison, sinon le même type. */
function suggestedKind(kind: PlanKind): PlanKind {
  if (kind === 'summer-circulation') return 'winter-circulation';
  if (kind === 'winter-circulation') return 'summer-circulation';
  return kind;
}

export function VariantDialog({
  planId,
  planName,
  onClose,
  onCreated,
}: {
  planId: string;
  planName: string;
  onClose(): void;
  onCreated(id: string): void;
}) {
  const [name, setName] = useState(t('variant.defaultName', { name: planName }));
  const [kind, setKind] = useState<PlanKind | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const create = async () => {
    setBusy(true);
    try {
      const doc = await repository.loadPlan(planId);
      if (!doc) throw new Error(t('plans.notFound'));
      const variant = createVariant(doc, name.trim() || planName, kind ?? suggestedKind(doc.plan.kind));
      await repository.savePlan(variant);
      onCreated(variant.plan.id);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      title={t('variant.title', { name: planName })}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button
            variant="primary"
            disabled={busy || !name.trim()}
            onClick={() => void create()}
            data-testid="variant-create"
          >
            {t('variant.create')}
          </Button>
        </>
      }
    >
      <div className="space-y-3" data-testid="variant-dialog">
        <p className="text-sm text-slate-600">{t('variant.help')}</p>
        <label className="block">
          <span className="mb-1 block font-medium text-slate-800">{t('variant.name')}</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded-md border border-slate-300 px-3 py-2"
          />
        </label>
        <VariantKind kind={kind} onChange={setKind} planId={planId} />
        {error && <p className="text-sm text-red-700">{error}</p>}
      </div>
    </Modal>
  );
}

function VariantKind({
  kind,
  onChange,
}: {
  kind: PlanKind | null;
  onChange(k: PlanKind): void;
  planId: string;
}) {
  return (
    <label className="block">
      <span className="mb-1 block font-medium text-slate-800">{t('variant.kind')}</span>
      <select
        value={kind ?? ''}
        onChange={(e) => onChange(e.target.value as PlanKind)}
        className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
        data-testid="variant-kind"
      >
        {kind === null && <option value="">{t('variant.kindAuto')}</option>}
        {PLAN_KINDS.map((k) => (
          <option key={k} value={k}>
            {t(`planKind.${k}`)}
          </option>
        ))}
      </select>
    </label>
  );
}
