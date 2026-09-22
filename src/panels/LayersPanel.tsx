import type { ReactNode } from 'react';
import { Eye, EyeOff, Lock, LockOpen } from 'lucide-react';
import { objectsInRenderOrder, replaceObject, setLayerFlag } from '@/domain/model/operations.ts';
import { t } from '@/i18n/index.ts';
import { useEditorStore } from '@/store/editorStore.ts';
import { planStore, usePlanStore } from '@/store/planStore.ts';

function FlagButton({
  on,
  label,
  onClick,
  children,
}: {
  on: boolean;
  label: string;
  onClick(): void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={on}
      onClick={onClick}
      className="inline-flex h-7 w-7 items-center justify-center rounded text-slate-600 hover:bg-slate-200 focus-visible:outline-2 focus-visible:outline-accent"
    >
      {children}
    </button>
  );
}

/**
 * Calques logiques du plan (du dessus vers le dessous) : afficher / masquer, verrouiller /
 * déverrouiller, et liste de leurs objets (clic = sélection ; l'œil réaffiche un objet masqué).
 */
export function LayersPanel() {
  const doc = usePlanStore((s) => s.doc);
  const selectedId = useEditorStore((s) => s.selectedId);
  if (!doc) return <p className="text-sm text-slate-500">{t('panel.layers.empty')}</p>;
  const ordered = objectsInRenderOrder(doc);

  return (
    <div className="space-y-3" data-testid="layers-panel">
      <ul className="space-y-2">
        {[...doc.layers].reverse().map((layer) => {
          const objects = ordered.filter((o) => o.layerId === layer.id).reverse();
          return (
            <li
              key={layer.id}
              className="rounded-md border border-slate-200 bg-white"
              data-testid="layer-row"
            >
              <div className="flex items-center gap-1 px-2 py-1">
                <span
                  className={`flex-1 truncate text-sm font-medium ${layer.visible ? 'text-slate-800' : 'text-slate-400'}`}
                >
                  {layer.name}
                </span>
                <span className="text-xs text-slate-400 tabular-nums">{objects.length}</span>
                <FlagButton
                  on={!layer.visible}
                  label={t(layer.visible ? 'layers.hide' : 'layers.show', { name: layer.name })}
                  onClick={() =>
                    planStore
                      .getState()
                      .update(layer.visible ? 'Masquer le calque' : 'Afficher le calque', (d) =>
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
                    planStore
                      .getState()
                      .update(layer.locked ? 'Déverrouiller le calque' : 'Verrouiller le calque', (d) =>
                        setLayerFlag(d, layer.id, 'locked', !layer.locked),
                      )
                  }
                >
                  {layer.locked ? <Lock size={15} /> : <LockOpen size={15} />}
                </FlagButton>
              </div>
              {objects.length > 0 && (
                <ul className="border-t border-slate-100 py-1">
                  {objects.map((object) => (
                    <li
                      key={object.id}
                      className={`flex items-center gap-1 pr-2 pl-4 ${object.id === selectedId ? 'bg-blue-50' : ''}`}
                    >
                      <button
                        type="button"
                        onClick={() => useEditorStore.getState().select(object.id)}
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
                          planStore
                            .getState()
                            .update(object.visible ? 'Masquer' : 'Afficher', (d) =>
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
      <p className="text-xs text-slate-500">{t('layers.reorderLater')}</p>
    </div>
  );
}
