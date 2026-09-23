import {
  ArrowDown,
  ArrowUp,
  Copy,
  Eye,
  EyeOff,
  Focus,
  Lock,
  LockOpen,
  Pencil,
  Plus,
  Trash2,
} from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { addLayer, deleteLayer, duplicateLayer, moveLayer, renameLayer } from '@/domain/model/layers.ts';
import { expandGroups } from '@/domain/model/multi.ts';
import { objectsInRenderOrder, replaceObject, setLayerFlag } from '@/domain/model/operations.ts';
import { RENDER_TIERS } from '@/domain/model/schema.ts';
import type { Layer, RenderTier } from '@/domain/model/types.ts';
import { t } from '@/i18n/index.ts';
import { useEditorStore } from '@/store/editorStore.ts';
import { planStore, usePlanStore } from '@/store/planStore.ts';
import { Button } from '@/ui/Button.tsx';
import { TextPromptDialog } from '@/ui/TextPromptDialog.tsx';

function FlagButton({
  on,
  label,
  onClick,
  disabled,
  children,
}: {
  on?: boolean;
  label: string;
  onClick(): void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={on}
      disabled={disabled}
      onClick={onClick}
      className="inline-flex h-7 w-7 items-center justify-center rounded text-slate-600 hover:bg-slate-200 focus-visible:outline-2 focus-visible:outline-accent disabled:text-slate-300 disabled:hover:bg-transparent"
    >
      {children}
    </button>
  );
}

const update = (label: string, recipe: Parameters<ReturnType<typeof planStore.getState>['update']>[1]) =>
  planStore.getState().update(label, recipe);

type Dialog = { kind: 'new' } | { kind: 'rename'; layer: Layer } | null;

/** Catégories proposées au filtre d'affichage (dans l'ordre de lecture d'un plan de circulation). */
const FILTER_TIERS: readonly RenderTier[] = [
  'circulation',
  'pedestrians',
  'parking',
  'deliveries',
  'signage',
  'safety',
  'zones',
  'buildings',
  'texts',
];

/**
 * Affichage par catégorie : chaque case affiche ou masque TOUS les calques de la catégorie
 * (plusieurs catégories à la fois) ; « seulement » n'affiche que cette catégorie.
 */
function CategoryFilter() {
  const layers = usePlanStore((s) => s.doc?.layers);
  if (!layers) return null;
  const tiers = FILTER_TIERS.filter((tier) => layers.some((l) => l.tier === tier));
  const setVisible = (label: string, visible: (l: Layer) => boolean) =>
    update(label, (d) => {
      for (const l of d.layers) setLayerFlag(d, l.id, 'visible', visible(l));
    });
  return (
    <fieldset className="rounded-md border border-slate-200 bg-white p-2" data-testid="category-filter">
      <legend className="px-1 text-xs font-semibold text-slate-700">{t('layers.categories')}</legend>
      <ul className="grid grid-cols-1 gap-0.5">
        {tiers.map((tier) => {
          const ofTier = layers.filter((l) => l.tier === tier);
          const shown = ofTier.some((l) => l.visible);
          const name = t(`tier.${tier}`);
          return (
            <li key={tier} className="flex items-center gap-2 text-sm">
              <label className="flex flex-1 items-center gap-2">
                <input
                  type="checkbox"
                  checked={shown}
                  onChange={() =>
                    setVisible(t(shown ? 'layers.hideCategory' : 'layers.showCategory', { name }), (l) =>
                      l.tier === tier ? !shown : l.visible,
                    )
                  }
                  className="accent-accent"
                />
                {name}
              </label>
              <button
                type="button"
                className="rounded px-1.5 text-xs text-accent hover:underline"
                aria-label={t('layers.onlyCategory', { name })}
                onClick={() => setVisible(t('layers.onlyCategory', { name }), (l) => l.tier === tier)}
              >
                {t('layers.only')}
              </button>
            </li>
          );
        })}
      </ul>
    </fieldset>
  );
}

/**
 * Calques du plan, du dessus (dessiné en dernier) vers le dessous. Chaque calque a une catégorie
 * logique. Cliquer son nom le rend actif : les nouveaux objets y sont ajoutés.
 */
export function LayersPanel() {
  const doc = usePlanStore((s) => s.doc);
  const selectedIds = useEditorStore((s) => s.selectedIds);
  const activeLayerId = useEditorStore((s) => s.activeLayerId);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [tier, setTier] = useState<RenderTier>('zones');
  if (!doc) return <p className="text-sm text-slate-500">{t('panel.layers.empty')}</p>;
  const ordered = objectsInRenderOrder(doc);
  const topDown = [...doc.layers].reverse();
  const onlyVisible = doc.layers.filter((l) => l.visible);

  return (
    <div className="space-y-3" data-testid="layers-panel">
      <div className="flex gap-2">
        <Button
          className="flex-1"
          onClick={() => {
            setTier('zones');
            setDialog({ kind: 'new' });
          }}
        >
          <Plus size={16} /> {t('layers.new')}
        </Button>
        <Button
          disabled={onlyVisible.length === doc.layers.length}
          onClick={() =>
            update(t('layers.showAll'), (d) => {
              for (const l of d.layers) setLayerFlag(d, l.id, 'visible', true);
            })
          }
        >
          {t('layers.showAll')}
        </Button>
      </div>
      <p className="text-xs text-slate-500">{t('layers.help')}</p>
      <CategoryFilter />

      <ul className="space-y-2">
        {topDown.map((layer, index) => {
          const objects = ordered.filter((o) => o.layerId === layer.id).reverse();
          const active = layer.id === activeLayerId;
          return (
            <li
              key={layer.id}
              className={`rounded-md border bg-white ${active ? 'border-accent ring-1 ring-accent' : 'border-slate-200'}`}
              data-testid="layer-row"
              data-layer-name={layer.name}
            >
              <div className="flex items-center gap-0.5 px-1.5 py-1">
                <button
                  type="button"
                  aria-pressed={active}
                  title={active ? t('layers.active') : t('layers.setActive', { name: layer.name })}
                  onClick={() => useEditorStore.getState().setActiveLayer(active ? null : layer.id)}
                  className={`min-w-0 flex-1 truncate text-left text-sm font-medium ${layer.visible ? 'text-slate-800' : 'text-slate-400'}`}
                >
                  {layer.name}
                  <span className="ml-1 text-[11px] font-normal text-slate-400">
                    {t(`tier.${layer.tier}`)} · {objects.length}
                  </span>
                </button>
                <FlagButton
                  on={!layer.visible}
                  label={t(layer.visible ? 'layers.hide' : 'layers.show', { name: layer.name })}
                  onClick={() =>
                    update(layer.visible ? 'Masquer le calque' : 'Afficher le calque', (d) =>
                      setLayerFlag(d, layer.id, 'visible', !layer.visible),
                    )
                  }
                >
                  {layer.visible ? <Eye size={15} /> : <EyeOff size={15} />}
                </FlagButton>
                <FlagButton
                  on={layer.locked}
                  label={t(layer.locked ? 'layers.unlock' : 'layers.lock', { name: layer.name })}
                  onClick={() =>
                    update(layer.locked ? 'Déverrouiller le calque' : 'Verrouiller le calque', (d) =>
                      setLayerFlag(d, layer.id, 'locked', !layer.locked),
                    )
                  }
                >
                  {layer.locked ? <Lock size={15} /> : <LockOpen size={15} />}
                </FlagButton>
              </div>
              <div className="flex items-center gap-0.5 border-t border-slate-100 px-1.5 py-0.5">
                <FlagButton
                  label={t('layers.up', { name: layer.name })}
                  disabled={index === 0}
                  onClick={() => update('Monter le calque', (d) => moveLayer(d, layer.id, 1))}
                >
                  <ArrowUp size={14} />
                </FlagButton>
                <FlagButton
                  label={t('layers.down', { name: layer.name })}
                  disabled={index === topDown.length - 1}
                  onClick={() => update('Descendre le calque', (d) => moveLayer(d, layer.id, -1))}
                >
                  <ArrowDown size={14} />
                </FlagButton>
                <FlagButton
                  label={t('layers.showOnly', { name: layer.name })}
                  onClick={() =>
                    update(t('layers.showOnly', { name: layer.name }), (d) => {
                      for (const l of d.layers) setLayerFlag(d, l.id, 'visible', l.id === layer.id);
                    })
                  }
                >
                  <Focus size={14} />
                </FlagButton>
                <span className="flex-1" />
                <FlagButton
                  label={t('layers.rename', { name: layer.name })}
                  onClick={() => setDialog({ kind: 'rename', layer })}
                >
                  <Pencil size={14} />
                </FlagButton>
                <FlagButton
                  label={t('layers.duplicate', { name: layer.name })}
                  onClick={() =>
                    update('Dupliquer le calque', (d) =>
                      duplicateLayer(d, layer.id, t('layers.copyName', { name: layer.name })),
                    )
                  }
                >
                  <Copy size={14} />
                </FlagButton>
                <FlagButton
                  label={
                    objects.length ? t('layers.deleteDisabled') : t('layers.delete', { name: layer.name })
                  }
                  disabled={objects.length > 0 || doc.layers.length <= 1}
                  onClick={() => {
                    update('Supprimer le calque', (d) => deleteLayer(d, layer.id));
                    if (active) useEditorStore.getState().setActiveLayer(null);
                  }}
                >
                  <Trash2 size={14} />
                </FlagButton>
              </div>
              {objects.length > 0 && (
                <ul className="border-t border-slate-100 py-1">
                  {objects.map((object) => (
                    <li
                      key={object.id}
                      className={`flex items-center gap-1 pr-1.5 pl-4 ${selectedIds.includes(object.id) ? 'bg-blue-50' : ''}`}
                    >
                      <button
                        type="button"
                        onClick={(e) => {
                          const ids = expandGroups(doc, [object.id]);
                          if (e.shiftKey) useEditorStore.getState().toggleSelection(ids);
                          else useEditorStore.getState().select(ids);
                        }}
                        className={`flex-1 truncate py-0.5 text-left text-xs ${object.visible ? 'text-slate-700' : 'text-slate-400 italic'} hover:underline`}
                      >
                        {object.name}
                        {object.locked && (
                          <Lock size={11} className="ml-1 inline" aria-label={t('props.locked')} />
                        )}
                      </button>
                      <FlagButton
                        on={!object.visible}
                        label={t(object.visible ? 'layers.hideObject' : 'layers.showObject', {
                          name: object.name,
                        })}
                        onClick={() =>
                          update(object.visible ? 'Masquer' : 'Afficher', (d) =>
                            replaceObject(d, { ...object, visible: !object.visible }),
                          )
                        }
                      >
                        {object.visible ? <Eye size={13} /> : <EyeOff size={13} />}
                      </FlagButton>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>

      {dialog?.kind === 'new' && (
        <TextPromptDialog
          title={t('layers.new')}
          label={t('layers.name')}
          initialValue=""
          confirmLabel={t('common.create')}
          onCancel={() => setDialog(null)}
          onConfirm={(name) => {
            let created: Layer | null = null;
            update('Nouveau calque', (d) => {
              created = addLayer(d, name, tier);
            });
            if (created) useEditorStore.getState().setActiveLayer((created as Layer).id);
            setDialog(null);
          }}
        >
          <label className="block">
            <span className="mb-1 block font-medium text-slate-800">{t('layers.category')}</span>
            <select
              value={tier}
              onChange={(e) => setTier(e.target.value as RenderTier)}
              className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
            >
              {RENDER_TIERS.map((value) => (
                <option key={value} value={value}>
                  {t(`tier.${value}`)}
                </option>
              ))}
            </select>
          </label>
        </TextPromptDialog>
      )}
      {dialog?.kind === 'rename' && (
        <TextPromptDialog
          title={t('layers.rename', { name: dialog.layer.name })}
          label={t('layers.name')}
          initialValue={dialog.layer.name}
          confirmLabel={t('common.save')}
          onCancel={() => setDialog(null)}
          onConfirm={(name) => {
            update('Renommer le calque', (d) => renameLayer(d, dialog.layer.id, name));
            setDialog(null);
          }}
        />
      )}
    </div>
  );
}
