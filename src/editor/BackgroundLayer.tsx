import { Image as KonvaImage, Layer } from 'react-konva';
import { chooseLevel } from '@/domain/viewport/pyramid.ts';
import type { LoadedBackground } from './backgroundImage.ts';

interface BackgroundLayerProps {
  background: LoadedBackground | null;
  scale: number;
  pixelRatio: number;
}

/**
 * Fond verrouillé : aucune écoute d'événement (ni sélection, ni déplacement, ni transformation),
 * toujours dessiné en (0, 0) à ses dimensions d'origine, quel que soit le niveau d'affichage.
 * - Agrandi (≥ 1 pixel écran par pixel image) : lissage désactivé → pixels nets, couleurs exactes.
 * - Très réduit : on dessine une copie d'affichage réduite de qualité, jamais enregistrée.
 */
export function BackgroundLayer({ background, scale, pixelRatio }: BackgroundLayerProps) {
  const devicePixelsPerImagePixel = scale * pixelRatio;
  const factor = background
    ? chooseLevel(
        background.levels.map((l) => l.factor),
        devicePixelsPerImagePixel,
      )
    : 1;
  const level = background?.levels.find((l) => l.factor === factor) ?? background?.levels[0];

  return (
    <Layer name="background" listening={false} imageSmoothingEnabled={devicePixelsPerImagePixel < 1}>
      {background && level && (
        <KonvaImage
          name="background-image"
          image={level.bitmap}
          x={0}
          y={0}
          width={background.width}
          height={background.height}
          listening={false}
          draggable={false}
          perfectDrawEnabled={false}
        />
      )}
    </Layer>
  );
}
