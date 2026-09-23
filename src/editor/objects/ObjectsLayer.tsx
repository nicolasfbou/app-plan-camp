import { memo, useMemo } from 'react';
import { Group, Layer } from 'react-konva';
import { expandGroups } from '@/domain/model/multi.ts';
import { isEditable, objectsInRenderOrder } from '@/domain/model/operations.ts';
import type { PlanObject } from '@/domain/model/types.ts';
import { viewFilter } from '@/domain/print/views.ts';
import { isShownInEditor } from '../viewVisibility.ts';
import { useEditorStore } from '@/store/editorStore.ts';
import { planStore, usePlanStore } from '@/store/planStore.ts';
import { ObjectNode } from './ObjectNode.tsx';
import { useSymbolImagesVersion } from './symbolImages.ts';

// Callbacks stables : les nœuds mémorisés ne sont pas redessinés inutilement.
/**
 * Clic sur un objet : un membre de groupe sélectionne tout le groupe ; Maj + clic ajoute ou retire
 * de la sélection ; un clic sur un objet déjà sélectionné garde la sélection (pour la déplacer).
 */
const select = (id: string, additive: boolean) => {
  const doc = planStore.getState().doc;
  const editor = useEditorStore.getState();
  if (!doc) return;
  // Membres d'un groupe masqués par la vue affichée : jamais sélectionnés (ni modifiés à l'aveugle).
  const ids = expandGroups(doc, [id]).filter((x) => doc.objects[x] && isShownInEditor(doc, doc.objects[x]));
  if (additive) editor.toggleSelection(ids);
  else if (!editor.selectedIds.includes(id)) editor.select(ids);
};
const openOnDoubleClick = (object: PlanObject) => {
  const editor = useEditorStore.getState();
  const doc = planStore.getState().doc;
  if (editor.tool !== 'select' || !doc || !isEditable(doc, object)) return;
  if (object.type === 'text') editor.setEditingText(object.id);
  else if (object.geometry.kind === 'polygon' || object.geometry.kind === 'polyline') {
    editor.select(object.id);
    editor.setVertexEditing(true);
  }
};

/**
 * Couche physique « content ». Un `Konva.Group` par calque du plan, dans l'ordre des calques
 * (réordonner les calques change donc réellement le rendu) ; chaque groupe porte aussi la
 * catégorie logique de son calque (nom `tier-<catégorie>`). Objets triés par zIndex dans le calque.
 */
export const ObjectsLayer = memo(function ObjectsLayer({ scaleBucket }: { scaleBucket: number }) {
  const doc = usePlanStore((s) => s.doc);
  const interactiveTool = useEditorStore((s) => s.tool === 'select');
  const editingTextId = useEditorStore((s) => s.editingTextId);
  const activeViewId = useEditorStore((s) => s.activeViewId);
  // Vue par public : calques et objets filtrés à l'affichage seulement (le plan n'est pas modifié).
  const filter = useMemo(() => (doc ? viewFilter(doc, activeViewId) : null), [doc, activeViewId]);
  const imagesVersion = useSymbolImagesVersion();

  // Répartition par calque recalculée seulement quand le document change.
  const byLayer = useMemo(() => {
    const map = new Map<string, PlanObject[]>(doc?.layers.map((l) => [l.id, []]) ?? []);
    if (doc) for (const object of objectsInRenderOrder(doc)) map.get(object.layerId)?.push(object);
    return map;
  }, [doc]);

  return (
    <Layer name="content">
      {doc?.layers.map((layer) => (
        <Group
          key={layer.id}
          id={`layer-${layer.id}`}
          name={`user-layer tier-${layer.tier}`}
          visible={layer.visible && !filter?.hiddenLayers.has(layer.id)}
          opacity={layer.opacity}
          listening={interactiveTool && !layer.locked}
        >
          {/* Calque masqué : ses objets ne sont pas créés du tout (aucun coût mémoire ni de rendu). */}
          {layer.visible &&
            !filter?.hiddenLayers.has(layer.id) &&
            byLayer
              .get(layer.id)!
              .map((object) =>
                object.visible && !filter?.hiddenObjects.has(object.id) ? (
                  <ObjectNode
                    key={object.id}
                    object={object}
                    editable={!object.locked && !layer.locked}
                    interactive={interactiveTool && !layer.locked}
                    hidden={editingTextId === object.id}
                    scale={scaleBucket}
                    display={doc.plan.display}
                    calibration={doc.plan.calibration}
                    units={doc.plan.units}
                    assets={doc.assets}
                    imagesVersion={imagesVersion}
                    onSelect={select}
                    onDoubleClick={openOnDoubleClick}
                  />
                ) : null,
              )}
        </Group>
      ))}
    </Layer>
  );
});
