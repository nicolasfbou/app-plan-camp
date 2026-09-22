import { Group, Layer } from 'react-konva';
import { isDisplayed, isEditable, objectsInRenderOrder } from '@/domain/model/operations.ts';
import type { PlanObject, RenderTier } from '@/domain/model/types.ts';
import { useEditorStore } from '@/store/editorStore.ts';
import { planStore, usePlanStore } from '@/store/planStore.ts';
import { CONTENT_GROUPS } from '../renderTiers.ts';
import { ObjectNode } from './ObjectNode.tsx';

// Callbacks stables : les nœuds mémorisés ne sont pas redessinés inutilement.
const select = (id: string) => useEditorStore.getState().select(id);
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
 * Couche physique « content » : les 6 catégories logiques, chacune dans son groupe nommé,
 * objets triés par calque puis zIndex.
 */
export function ObjectsLayer({ scale }: { scale: number }) {
  const doc = usePlanStore((s) => s.doc);
  const interactiveTool = useEditorStore((s) => s.tool === 'select');
  const editingTextId = useEditorStore((s) => s.editingTextId);
  // Paliers de zoom (puissances de 2) : les zones de clic ne sont recalculées qu'à ces paliers.
  const scaleBucket = 2 ** Math.round(Math.log2(Math.max(scale, 1e-6)));

  const byTier = new Map<RenderTier, PlanObject[]>(CONTENT_GROUPS.map((tier) => [tier, []]));
  const tierOfLayer = new Map(doc?.layers.map((l) => [l.id, l]) ?? []);
  if (doc) {
    for (const object of objectsInRenderOrder(doc)) {
      const layer = tierOfLayer.get(object.layerId);
      if (layer) byTier.get(layer.tier)?.push(object);
    }
  }

  return (
    <Layer name="content">
      {CONTENT_GROUPS.map((tier) => (
        <Group key={tier} name={tier}>
          {doc &&
            byTier.get(tier)!.map((object) => {
              const layer = tierOfLayer.get(object.layerId)!;
              if (!isDisplayed(doc, object)) return null;
              return (
                <ObjectNode
                  key={object.id}
                  object={object}
                  editable={isEditable(doc, object)}
                  interactive={interactiveTool && !layer.locked}
                  hidden={editingTextId === object.id}
                  scale={scaleBucket}
                  onSelect={select}
                  onDoubleClick={openOnDoubleClick}
                />
              );
            })}
        </Group>
      ))}
    </Layer>
  );
}
