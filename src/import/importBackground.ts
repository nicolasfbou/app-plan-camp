/**
 * Import d'un fond de plan : lit les octets d'origine, identifie le format réel, lit les
 * dimensions et l'orientation sans décoder, évalue le risque, puis (après confirmation
 * éventuelle) décode pour l'affichage et enregistre l'ORIGINAL tel quel avec son empreinte.
 */
import type { BaseImageRef } from '@/domain/model/types.ts';
import { nowIso } from '@/domain/model/factories.ts';
import { sha256Hex } from '@/domain/image/hash.ts';
import {
  type ImageHeader,
  ImageHeaderError,
  MIME_TYPES,
  readImageHeader,
  sniffFormat,
} from '@/domain/image/header.ts';
import { type SizeAssessment, assessImageSize } from '@/domain/image/sizeAssessment.ts';
import type { ProjectRepository } from '@/persistence/ProjectRepository.ts';
import { decodeImage } from './decodeImage.ts';
import { ImportError } from './errors.ts';
import { type LoadedPdf, openPdf } from './pdf.ts';

export interface SourceFile {
  name: string;
  bytes: ArrayBuffer;
}

export type PreparedImport =
  | { kind: 'image'; file: SourceFile; header: ImageHeader; assessment: SizeAssessment }
  | { kind: 'pdf'; file: SourceFile; pdf: LoadedPdf };

export interface ImportedBackground {
  ref: BaseImageRef;
  bitmap: ImageBitmap;
}

export async function prepareImport(file: SourceFile): Promise<PreparedImport> {
  if (file.bytes.byteLength === 0) throw new ImportError('Le fichier est vide.');
  const format = sniffFormat(new Uint8Array(file.bytes));
  if (format === null) {
    throw new ImportError('Format non pris en charge. Formats acceptés : JPG, JPEG, PNG, WEBP et PDF.');
  }
  if (format === 'pdf') return { kind: 'pdf', file, pdf: await openPdf(file.bytes) };
  try {
    const header = readImageHeader(new Uint8Array(file.bytes));
    return { kind: 'image', file, header, assessment: assessImageSize(header.width, header.height) };
  } catch (error) {
    if (error instanceof ImageHeaderError) throw new ImportError(error.message);
    throw error;
  }
}

async function storeImage(
  repo: ProjectRepository,
  file: SourceFile,
  header: ImageHeader,
  source: BaseImageRef['source'],
): Promise<ImportedBackground> {
  const mimeType = MIME_TYPES[header.format];
  const bitmap = await decodeImage(file.bytes, mimeType);
  // Les coordonnées du projet sont celles de l'image affichée : on retient ce que le navigateur
  // affiche réellement (orientation appliquée), qui doit concorder avec l'en-tête.
  if (bitmap.width !== header.width || bitmap.height !== header.height) {
    bitmap.close();
    throw new ImportError(
      `Dimensions incohérentes : l'en-tête annonce ${header.width} × ${header.height} px, ` +
        `le navigateur affiche ${bitmap.width} × ${bitmap.height} px. Import annulé par sécurité.`,
    );
  }
  const stored = await repo.putBlob(file.bytes, mimeType);
  return {
    bitmap,
    ref: {
      blobId: stored.id,
      fileName: file.name,
      mimeType,
      byteLength: stored.byteLength,
      sha256: stored.sha256,
      width: header.width,
      height: header.height,
      exifOrientation: header.exifOrientation,
      importedAt: nowIso(),
      source,
    },
  };
}

export function finalizeImageImport(
  repo: ProjectRepository,
  prepared: Extract<PreparedImport, { kind: 'image' }>,
): Promise<ImportedBackground> {
  return storeImage(repo, prepared.file, prepared.header, { kind: 'image' });
}

export async function finalizePdfImport(
  repo: ProjectRepository,
  prepared: Extract<PreparedImport, { kind: 'pdf' }>,
  page: number,
  dpi: number,
): Promise<ImportedBackground> {
  const png = await prepared.pdf.renderPng(page, dpi);
  const pdfBlob = await repo.putBlob(prepared.file.bytes, MIME_TYPES.pdf);
  const baseName = prepared.file.name.replace(/\.pdf$/i, '');
  return storeImage(
    repo,
    { name: `${baseName} - page ${page} (${dpi} ppp).png`, bytes: png },
    readImageHeader(new Uint8Array(png)),
    {
      kind: 'pdf',
      pdfBlobId: pdfBlob.id,
      pdfFileName: prepared.file.name,
      pdfByteLength: pdfBlob.byteLength,
      pdfSha256: pdfBlob.sha256,
      pageCount: prepared.pdf.pageCount,
      page,
      dpi,
    },
  );
}

/** Recalcule l'empreinte des octets stockés et la compare à celle enregistrée à l'import. */
export async function verifyStoredBlob(repo: ProjectRepository, blobId: string, expectedSha256: string) {
  const blob = await repo.getBlob(blobId);
  if (!blob) return { ok: false as const, reason: 'missing' as const };
  const actual = await sha256Hex(blob.bytes);
  return actual === expectedSha256
    ? { ok: true as const, blob }
    : { ok: false as const, reason: 'mismatch' as const };
}
