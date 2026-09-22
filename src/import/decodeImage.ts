import { ImportError } from './errors.ts';

/**
 * Décode des octets d'image pour l'AFFICHAGE, orientation EXIF appliquée. Les octets reçus ne
 * sont pas modifiés (le Blob en fait une copie) ; aucun filtre, aucun redimensionnement.
 */
export async function decodeImage(bytes: ArrayBuffer, mimeType: string): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(new Blob([bytes], { type: mimeType }), {
      imageOrientation: 'from-image',
      premultiplyAlpha: 'default',
      colorSpaceConversion: 'default',
    });
  } catch {
    throw new ImportError(
      "Le navigateur n'a pas pu décoder cette image : le fichier est peut-être corrompu, ou trop grand pour la mémoire disponible.",
    );
  }
}
