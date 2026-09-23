/**
 * Vues par public et style d'impression. Une vue ne copie jamais les objets : c'est un filtre et
 * des réglages d'impression enregistrés dans le plan (et le .campplan).
 */
import { Copy, Eye, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { Audience, PlanDocument, PrintStyle } from '@/domain/model/types.ts';
import { AUDIENCE_LABELS, createView, editableSettings, styleFromPreset } from '@/domain/print/views.ts';
import { newId } from '@/domain/model/factories.ts';
import { t, type MessageKey } from '@/i18n/index.ts';
import { Row, Section, SelectField, TextField, Toggle } from '@/panels/fields.tsx';
import { useEditorStore } from '@/store/editorStore.ts';
import { planStore } from '@/store/planStore.ts';
import { Button } from '@/ui/Button.tsx';
import { ConfirmDialog } from '@/ui/ConfirmDialog.tsx';

const update = (label: string, recipe: (d: PlanDocument) => void, mergeKey?: string) =>
  planStore.getState().update(label, recipe, mergeKey ? { mergeKey } : undefined);

const AUDIENCES = Object.keys(AUDIENCE_LABELS) as Audience[];

/** Choix de la vue (plan de base ou vue par public) ; création, copie, suppression. */
export function ViewSelector({ doc }: { doc: PlanDocument }) {
  const viewId = useEditorStore((s) => s.activeViewId);
  const setView = useEditorStore((s) => s.setActiveView);
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const current = viewId ? doc.plan.views.find((v) => v.id === viewId) : undefined;
  const create = (audience: Audience) => {
    const view = createView(doc, audience);
    update(`Créer la vue ${view.name}`, (d) => void d.plan.views.push(view));
    setView(view.id);
    setAdding(false);
  };
  return (
    <Section title={t('views.title')}>
      <SelectField
        label={t('views.current')}
        value={current?.id ?? ''}
        options={[
          { value: '', label: t('views.base') },
          ...doc.plan.views.map((v) => ({ value: v.id, label: v.name })),
        ]}
        onChange={(id) => setView(id || null)}
      />
      <p className="text-xs text-slate-500">{t('views.help')}</p>
      <div className="flex flex-wrap gap-1">
        <Button onClick={() => setAdding((a) => !a)} aria-expanded={adding} data-testid="view-add">
          <Plus size={16} /> {t('views.add')}
        </Button>
        {current && (
          <>
            <Button
              title={t('views.duplicate')}
              aria-label={t('views.duplicate')}
              onClick={() => {
                const copy = {
                  ...structuredClone(current),
                  id: newId(),
                  name: t('views.copyName', { name: current.name }),
                };
                update('Dupliquer la vue', (d) => void d.plan.views.push(copy));
                setView(copy.id);
              }}
            >
              <Copy size={16} />
            </Button>
            <Button
              title={t('views.delete')}
              aria-label={t('views.delete')}
              onClick={() => setDeleting(true)}
            >
              <Trash2 size={16} />
            </Button>
          </>
        )}
      </div>
      {adding && (
        <div className="grid grid-cols-2 gap-1" role="group" aria-label={t('views.add')}>
          {AUDIENCES.map((a) => (
            <Button key={a} onClick={() => create(a)} data-audience={a}>
              {AUDIENCE_LABELS[a]}
            </Button>
          ))}
        </div>
      )}
      {deleting && current && (
        <ConfirmDialog
          title={t('views.delete')}
          confirmLabel={t('common.delete')}
          danger
          onCancel={() => setDeleting(false)}
          onConfirm={() => {
            update(
              'Supprimer la vue',
              (d) => void (d.plan.views = d.plan.views.filter((v) => v.id !== current.id)),
            );
            setView(null);
            setDeleting(false);
          }}
        >
          {t('views.deleteBody', { name: current.name })}
        </ConfirmDialog>
      )}
    </Section>
  );
}

const setView = (
  viewId: string,
  label: string,
  recipe: (v: PlanDocument['plan']['views'][number]) => void,
  mergeKey?: string,
) =>
  update(
    label,
    (d) => {
      const view = d.plan.views.find((v) => v.id === viewId);
      if (view) recipe(view);
    },
    mergeKey,
  );

/** Réglages propres à une vue : nom, titre, public, niveau de détail, éléments exclus. */
export function ViewSection({ doc, viewId }: { doc: PlanDocument; viewId: string }) {
  const view = doc.plan.views.find((v) => v.id === viewId);
  if (!view) return null;
  const excluded = view.print.excludedObjectIds.map((id) => doc.objects[id]).filter(Boolean);
  return (
    <Section title={t('views.settings', { name: view.name })}>
      <TextField
        label={t('views.name')}
        value={view.name}
        onChange={(name) =>
          setView(view.id, 'Nom de la vue', (v) => void (v.name = name), `view-name-${view.id}`)
        }
      />
      <SelectField
        label={t('views.audience')}
        value={view.audience}
        options={AUDIENCES.map((a) => ({ value: a, label: AUDIENCE_LABELS[a] }))}
        onChange={(audience) => setView(view.id, 'Public de la vue', (v) => void (v.audience = audience))}
      />
      <TextField
        label={t('views.printTitle')}
        value={view.title}
        onChange={(title) =>
          setView(view.id, 'Titre de la vue', (v) => void (v.title = title), `view-title-${view.id}`)
        }
      />
      <TextField
        label={t('views.audienceNote')}
        value={view.audienceNote}
        onChange={(audienceNote) =>
          setView(
            view.id,
            'Mention du public',
            (v) => void (v.audienceNote = audienceNote),
            `view-note-${view.id}`,
          )
        }
      />
      <div>
        <p className="mb-1 text-xs text-slate-600">{t('views.excluded', { count: excluded.length })}</p>
        {excluded.length === 0 ? (
          <p className="text-xs text-slate-500">{t('views.excludedHelp')}</p>
        ) : (
          <ul className="space-y-1" data-testid="view-excluded">
            {excluded.map((o) => (
              <li key={o!.id} className="flex items-center gap-2 text-xs">
                <span className="min-w-0 flex-1 truncate">{o!.name}</span>
                <Button
                  title={t('views.restore')}
                  aria-label={t('views.restoreOf', { name: o!.name })}
                  onClick={() =>
                    setView(view.id, 'Réafficher dans la vue', (v) => {
                      v.print.excludedObjectIds = v.print.excludedObjectIds.filter((id) => id !== o!.id);
                    })
                  }
                >
                  <Eye size={14} />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Section>
  );
}

const PRESETS = ['standard', 'field', 'client', 'supplier', 'employees', 'bw'] as const;

/** Niveau de détail et style d'impression (rendu seulement : l'original n'est jamais modifié). */
export function StyleSection({ doc, viewId }: { doc: PlanDocument; viewId: string | null }) {
  const { print } = editableSettings(doc, viewId);
  const style = print.style;
  const setStyle = (label: string, recipe: (s: PrintStyle) => void, mergeKey?: string) =>
    update(
      label,
      (d) => {
        const s = editableSettings(d, viewId).print.style;
        recipe(s);
      },
      mergeKey,
    );
  // Un réglage modifié à la main : style « personnalisé ».
  const tweak = (key: keyof Omit<PrintStyle, 'preset'>, value: number | boolean) =>
    setStyle(
      'Style d’impression',
      (s) => {
        (s as Record<string, unknown>)[key] = value;
        s.preset = 'custom';
      },
      `style-${viewId ?? 'base'}-${key}`,
    );
  const slider = (
    key: 'photoDim' | 'photoContrast' | 'strokeScale' | 'iconScale' | 'minTextPt',
    min: number,
    max: number,
    step: number,
    format: (v: number) => string,
  ) => (
    <label className="block text-xs text-slate-600">
      <span className="flex justify-between">
        <span>{t(`style.${key}` as MessageKey)}</span>
        <span className="tabular-nums">{format(style[key])}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={style[key]}
        onChange={(e) => tweak(key, Number(e.target.value))}
        className="w-full accent-accent"
        data-testid={`style-${key}`}
      />
    </label>
  );
  const pct = (v: number) => `${Math.round(v * 100)} %`;
  const times = (v: number) => `× ${v.toFixed(2).replace('.', ',')}`;
  return (
    <Section title={t('style.title')}>
      <Row>
        <SelectField
          label={t('style.preset')}
          value={style.preset}
          options={[
            ...PRESETS.map((p) => ({ value: p, label: t(`style.preset.${p}` as MessageKey) })),
            ...(style.preset === 'custom'
              ? [{ value: 'custom' as const, label: t('style.preset.custom') }]
              : []),
          ]}
          onChange={(preset) => {
            if (preset === 'custom') return;
            setStyle('Préréglage d’impression', (s) => Object.assign(s, styleFromPreset(preset)));
          }}
        />
        <SelectField
          label={t('style.detail')}
          value={print.detail}
          options={(['full', 'standard', 'simplified'] as const).map((d) => ({
            value: d,
            label: t(`style.detail.${d}`),
          }))}
          onChange={(detail) =>
            update('Niveau de détail', (d) => void (editableSettings(d, viewId).print.detail = detail))
          }
        />
      </Row>
      <p className="text-xs text-slate-500">{t(`style.detailHelp.${print.detail}`)}</p>
      {slider('photoDim', 0, 0.9, 0.05, pct)}
      {slider('photoContrast', 0.5, 2, 0.05, pct)}
      {slider('strokeScale', 0.5, 3, 0.05, times)}
      {slider('iconScale', 0.5, 3, 0.05, times)}
      {slider('minTextPt', 0, 24, 0.5, (v) => (v ? `${String(v).replace('.', ',')} pt` : t('style.noMin')))}
      <Toggle
        label={t('style.grayscale')}
        checked={style.grayscale}
        onChange={(v) => tweak('grayscale', v)}
      />
      <Toggle
        label={t('style.simpleLegend')}
        checked={style.simpleLegend}
        onChange={(v) => tweak('simpleLegend', v)}
      />
      <p className="text-xs text-slate-500">{t('style.renderOnly')}</p>
    </Section>
  );
}
