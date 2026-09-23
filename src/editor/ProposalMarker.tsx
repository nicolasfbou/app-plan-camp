/**
 * Aperçu d'une proposition de placement d'étiquette (jamais appliquée seule) : cadre pointillé à
 * l'emplacement proposé et ligne de renvoi, dans la couche « overlay ».
 */
import { Group, Line, Rect } from 'react-konva';
import { useEditorStore } from '@/store/editorStore.ts';

export function ProposalMarker({ scale }: { scale: number }) {
  const p = useEditorStore((s) => s.labelProposal);
  if (!p) return null;
  const s = 1 / Math.max(scale, 1e-9);
  return (
    <Group listening={false} name="label-proposal">
      {p.leaderTo && (
        <Line
          points={[p.at.x, p.at.y, p.leaderTo.x, p.leaderTo.y]}
          stroke="#16a34a"
          strokeWidth={2 * s}
          dash={[6 * s, 4 * s]}
        />
      )}
      <Rect
        x={p.at.x - p.width / 2}
        y={p.at.y - p.height / 2}
        width={p.width}
        height={p.height}
        stroke="#16a34a"
        strokeWidth={2.5 * s}
        dash={[8 * s, 5 * s]}
        fill="rgba(22, 163, 74, 0.15)"
      />
    </Group>
  );
}
