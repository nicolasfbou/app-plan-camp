/**
 * Police des exports : Liberation Sans (licence SIL OFL 1.1, métriques identiques à Arial).
 * Chargée à la demande (jamais au démarrage de l'application), intégrée au PDF pour que les
 * caractères accentués et les symboles (≈, ², →) s'impriment correctement, et déclarée au
 * navigateur pour que l'aperçu et les PNG utilisent exactement les mêmes largeurs de texte.
 */
import boldUrl from './fonts/LiberationSans-Bold.ttf?url';
import regularUrl from './fonts/LiberationSans-Regular.ttf?url';

export const EXPORT_FONT_FAMILY = 'CampPlanner Export Sans';
/** Pile de polices du canevas : la police chargée, sinon des polices aux mêmes métriques. */
export const CANVAS_FONT_STACK = `"${EXPORT_FONT_FAMILY}", "Liberation Sans", Arial, sans-serif`;

export interface ExportFonts {
  regular: ArrayBuffer;
  bold: ArrayBuffer;
}

let loading: Promise<ExportFonts> | null = null;

async function fetchBytes(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Police d’export introuvable (${response.status}).`);
  return response.arrayBuffer();
}

/** Octets des polices (mis en cache), et polices déclarées au navigateur pour le canevas. */
export function loadExportFonts(): Promise<ExportFonts> {
  loading ??= (async () => {
    const [regular, bold] = await Promise.all([fetchBytes(regularUrl), fetchBytes(boldUrl)]);
    if (typeof FontFace !== 'undefined' && typeof document !== 'undefined') {
      const faces = [
        new FontFace(EXPORT_FONT_FAMILY, regular.slice(0), { weight: '400' }),
        new FontFace(EXPORT_FONT_FAMILY, bold.slice(0), { weight: '700' }),
      ];
      for (const face of faces) document.fonts.add(await face.load());
    }
    return { regular, bold };
  })().catch((error: unknown) => {
    loading = null; // nouvel essai possible (réseau revenu)
    throw error;
  });
  return loading;
}

export function toBase64(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let binary = '';
  for (let i = 0; i < view.length; i += 0x8000)
    binary += String.fromCharCode(...view.subarray(i, i + 0x8000));
  return btoa(binary);
}
