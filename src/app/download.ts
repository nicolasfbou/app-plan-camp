/** Propose au navigateur d'enregistrer des octets sous le nom donné (aucune conversion). */
export function downloadBytes(bytes: Uint8Array | ArrayBuffer, fileName: string, mimeType: string): void {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mimeType }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
