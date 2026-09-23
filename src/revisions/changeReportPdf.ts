/**
 * Rapport de changements en PDF (Lettre paysage) : en-tête, révisions comparées, résumé, image de
 * superposition avec sa légende, puis le détail (objets, réglages, changements automatiques).
 */
import type { ChangeReport } from '@/domain/revisions/report.ts';
import { loadExportFonts } from '@/export/fonts.ts';
import { MARKER_COLORS } from './compareRender.ts';

const PAGE = { width: 279.4, height: 215.9 };
const M = 12;

export async function changeReportPdf(
  report: ChangeReport,
  overlay: HTMLCanvasElement | null,
): Promise<Uint8Array> {
  const [{ jsPDF }, { registerPdfFonts, PDF_FONT }, fonts] = await Promise.all([
    import('jspdf'),
    import('@/export/pdfPainter.ts'),
    loadExportFonts(),
  ]);
  const pdf = new jsPDF({ unit: 'mm', format: 'letter', orientation: 'landscape', compress: true });
  registerPdfFonts(pdf, fonts);
  const font = (size: number, bold = false, color = '#0f172a') => {
    pdf.setFont(PDF_FONT, bold ? 'bold' : 'normal');
    pdf.setFontSize(size);
    pdf.setTextColor(color);
  };
  const line = (size: number) => size * 0.3528 * 1.3;

  // --- Page 1 ------------------------------------------------------------------------------------
  font(15, true);
  pdf.text(report.title, M, M + 4);
  font(9, false, '#475569');
  pdf.text(report.subtitle, M, M + 10);
  const colW = 100;
  let y = M + 18;
  // Tableau des deux états.
  const [a, b] = report.sides;
  const rows: [string, string, string][] = [
    ['', a.name, b.name],
    ['Description', a.description, b.description],
    ['Date', a.date, b.date],
    ['Auteur', a.author, b.author],
    ['Statut', a.status, b.status],
    ['Approbation', a.approval, b.approval],
  ];
  for (const [i, [label, x, z]] of rows.entries()) {
    font(7.5, i === 0, i === 0 ? '#0f172a' : '#334155');
    pdf.text(label, M, y);
    const wx = pdf.splitTextToSize(x || '—', 36) as string[];
    const wz = pdf.splitTextToSize(z || '—', 36) as string[];
    pdf.text(wx, M + 24, y);
    pdf.text(wz, M + 62, y);
    y += Math.max(wx.length, wz.length) * line(7.5) + 0.8;
  }
  y += 3;
  font(10, true);
  pdf.text('Résumé — changements faits par l’utilisateur', M, y);
  y += 5;
  font(8.5);
  for (const l of report.summary) {
    const wrapped = pdf.splitTextToSize(`• ${l}`, colW) as string[];
    if (y + wrapped.length * line(8.5) > PAGE.height - M - 8) {
      pdf.text('… (suite au détail)', M, y);
      break;
    }
    pdf.text(wrapped, M, y);
    y += wrapped.length * line(8.5) + 0.6;
  }
  // Superposition, à droite.
  if (overlay) {
    const box = {
      x: M + colW + 6,
      y: M + 14,
      width: PAGE.width - 2 * M - colW - 6,
      height: PAGE.height - 2 * M - 26,
    };
    const k = Math.min(box.width / overlay.width, box.height / overlay.height);
    const w = overlay.width * k;
    const h = overlay.height * k;
    pdf.addImage(overlay.toDataURL('image/jpeg', 0.85), 'JPEG', box.x, box.y, w, h);
    pdf.setDrawColor('#94a3b8');
    pdf.rect(box.x, box.y, w, h);
    let lx = box.x;
    const ly = box.y + h + 5;
    const legend: [string, string][] = [
      [MARKER_COLORS.added, 'Ajouté'],
      [MARKER_COLORS.removed, 'Supprimé (ancienne position)'],
      [MARKER_COLORS.moved, 'Déplacé (ancienne position en gris)'],
      [MARKER_COLORS.modified, 'Modifié'],
    ];
    font(7, false, '#334155');
    for (const [color, text] of legend) {
      pdf.setFillColor(color);
      pdf.rect(lx, ly - 2.5, 3, 3, 'F');
      pdf.text(text, lx + 4, ly);
      lx += pdf.getTextWidth(text) + 10;
    }
    font(7, false, '#64748b');
    pdf.text(
      'Ancienne version en gris ; numéros = détail du rapport. Données non modifiées par la comparaison.',
      box.x,
      ly + 5,
    );
  }
  font(6.5, false, '#64748b');
  pdf.text(pdf.splitTextToSize(report.footer, PAGE.width - 2 * M) as string[], M, PAGE.height - M + 2);

  // --- Détail -------------------------------------------------------------------------------------
  pdf.addPage('letter', 'landscape');
  y = M + 4;
  const width = PAGE.width - 2 * M;
  const ensure = (needed: number) => {
    if (y + needed > PAGE.height - M) {
      pdf.addPage('letter', 'landscape');
      y = M + 4;
    }
  };
  const sections = [
    ...report.sections,
    { title: 'Changements automatiques (non comptés)', lines: report.auto.length ? report.auto : ['Aucun.'] },
  ];
  for (const section of sections) {
    ensure(12);
    font(10.5, true);
    pdf.text(section.title, M, y);
    y += 5.5;
    font(8.5);
    for (const l of section.lines) {
      const wrapped = pdf.splitTextToSize(l, width) as string[];
      ensure(wrapped.length * line(8.5));
      pdf.text(wrapped, M, y);
      y += wrapped.length * line(8.5) + 0.8;
    }
    y += 3;
  }
  pdf.setProperties({ title: report.title, subject: report.subtitle, creator: 'CampPlanner' });
  return new Uint8Array(pdf.output('arraybuffer'));
}
