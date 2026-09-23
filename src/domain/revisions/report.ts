/**
 * Rapport de changements entre deux états d'un plan (texte structuré, réutilisé par le rapport
 * PDF et le fichier Markdown). Les changements de l'utilisateur et les changements automatiques
 * sont présentés séparément ; seuls les premiers sont comptés.
 */
import {
  AREA_LABELS,
  CHANGE_KIND_LABELS,
  nounLabel,
  type PlanDiff,
  type SettingArea,
  summarizeDiff,
} from './diff.ts';

export interface ReportSide {
  /** « Révision A » ou « Brouillon actuel ». */
  name: string;
  description: string;
  date: string;
  author: string;
  status: string;
  approval: string;
}

export interface ReportSection {
  title: string;
  lines: string[];
}

export interface ChangeReport {
  title: string;
  subtitle: string;
  sides: [ReportSide, ReportSide];
  summary: string[];
  sections: ReportSection[];
  auto: string[];
  footer: string;
}

const AREA_ORDER: SettingArea[] = [
  'titleBlock',
  'layers',
  'views',
  'print',
  'legend',
  'plan',
  'photo',
  'assets',
  'reviews',
];

export function buildChangeReport(
  diff: PlanDiff,
  before: ReportSide,
  after: ReportSide,
  context: { planName: string; siteName: string; generatedAt: string },
): ChangeReport {
  const summary = summarizeDiff(diff);
  const sections: ReportSection[] = [];
  if (diff.objects.length)
    sections.push({
      title: `Objets (${diff.objects.length})`,
      lines: diff.objects.map((c, i) => {
        const kinds = c.kinds.map((k) => CHANGE_KIND_LABELS[k].toLowerCase()).join(', ');
        const name = c.name ? ` « ${c.name} »` : '';
        const details = c.details.length ? ` — ${c.details.join(' ; ')}` : '';
        return `${i + 1}. ${nounLabel(c.noun)[0]!.toUpperCase()}${nounLabel(c.noun).slice(1)}${name} : ${kinds}${details}`;
      }),
    });
  for (const area of AREA_ORDER) {
    const list = diff.settings.filter((s) => s.area === area);
    if (!list.length) continue;
    sections.push({
      title: `${AREA_LABELS[area]} (${list.length})`,
      lines: list.map((s) => {
        const values = s.before === '—' && s.after === '—' ? '' : ` : ${s.before} → ${s.after}`;
        return `${s.subject === 'cartouche' || s.subject === 'plan' ? '' : `${s.subject} — `}${s.label}${values}`;
      }),
    });
  }
  return {
    title: `Rapport de changements — ${before.name} → ${after.name}`,
    subtitle: `${context.siteName ? `${context.siteName} — ` : ''}${context.planName}`,
    sides: [before, after],
    summary: summary.length ? summary : ['Aucun changement fait par l’utilisateur.'],
    sections,
    auto: diff.auto.map((a) => `${a.label} — ${a.detail}`),
    footer: `Généré par CampPlanner le ${context.generatedAt.slice(0, 16).replace('T', ' ')} (UTC). ${diff.counts.user} changement(s) de l’utilisateur, ${diff.counts.auto} changement(s) automatique(s) non compté(s). Plan illustratif : positions à valider sur le terrain.`,
  };
}

/** Rapport en Markdown (lisible tel quel, joignable à un courriel). */
export function changeReportMarkdown(report: ChangeReport): string {
  const [a, b] = report.sides;
  const row = (label: string, x: string, y: string) => `| ${label} | ${x || '—'} | ${y || '—'} |`;
  return [
    `# ${report.title}`,
    '',
    report.subtitle,
    '',
    `| | ${a.name} | ${b.name} |`,
    '| --- | --- | --- |',
    row('Description', a.description, b.description),
    row('Date', a.date, b.date),
    row('Auteur', a.author, b.author),
    row('Statut', a.status, b.status),
    row('Approbation', a.approval, b.approval),
    '',
    '## Résumé (changements faits par l’utilisateur)',
    '',
    ...report.summary.map((l) => `- ${l}`),
    '',
    ...report.sections.flatMap((s) => [`## ${s.title}`, '', ...s.lines.map((l) => `- ${l}`), '']),
    '## Changements automatiques (non comptés)',
    '',
    ...(report.auto.length ? report.auto.map((l) => `- ${l}`) : ['- Aucun.']),
    '',
    `_${report.footer}_`,
    '',
  ].join('\n');
}
