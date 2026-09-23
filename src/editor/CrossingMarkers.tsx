/**
 * Marqueurs discrets des croisements piétons / véhicules (couche de surcouche, taille fixe à
 * l'écran). Un clic ouvre le croisement dans l'onglet Analyse.
 */
import { Circle, Group, Text } from 'react-konva';
import { useEditorStore } from '@/store/editorStore.ts';
import { useUiStore } from '@/store/uiStore.ts';
import { useCrossings } from './crossings.ts';

const FILL = { open: '#f59e0b', vigilance: '#dc2626', verified: '#64748b' } as const;

export function CrossingMarkers({ scale }: { scale: number }) {
  const crossings = useCrossings();
  const showVerified = useEditorStore((s) => s.showVerifiedCrossings);
  const selected = useEditorStore((s) => s.selectedCrossing);
  const px = 1 / scale;
  return (
    <>
      {crossings
        .filter((c) => showVerified || c.status !== 'verified')
        .map((c) => {
          const r = (c.key === selected ? 11 : 8) * px;
          return (
            <Group
              key={c.key}
              name="crossing-marker"
              id={`crossing-${c.key}`}
              x={c.point.x}
              y={c.point.y}
              onPointerDown={(e) => {
                e.cancelBubble = true;
                useEditorStore.getState().selectCrossing(c.key);
                useUiStore.getState().setRightTab('analysis');
              }}
            >
              <Circle radius={r} fill={FILL[c.status]} stroke="#ffffff" strokeWidth={2 * px} opacity={0.92} />
              <Text
                text={c.status === 'verified' ? '✓' : '!'}
                fontSize={r * 1.4}
                fontStyle="bold"
                fill="#ffffff"
                width={r * 2}
                height={r * 2}
                offsetX={r}
                offsetY={r}
                align="center"
                verticalAlign="middle"
                listening={false}
              />
            </Group>
          );
        })}
    </>
  );
}
