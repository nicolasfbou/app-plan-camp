import type { ReactNode } from 'react';

interface ListRowProps {
  href: string;
  title: string;
  subtitle: string;
  icon: ReactNode;
  actions: ReactNode;
  testId?: string;
}

/** Ligne de liste cliquable (camp, plan) avec ses actions à droite. */
export function ListRow({ href, title, subtitle, icon, actions, testId }: ListRowProps) {
  return (
    <li
      className="flex items-center gap-3 rounded-lg border border-slate-200 bg-white px-4 py-3 hover:border-slate-300"
      data-testid={testId}
    >
      <span className="text-slate-500" aria-hidden>
        {icon}
      </span>
      <a href={href} className="min-w-0 flex-1 focus-visible:outline-2 focus-visible:outline-accent">
        <span className="block truncate font-medium text-slate-900">{title}</span>
        <span className="block truncate text-xs text-slate-500">{subtitle}</span>
      </a>
      <div className="flex shrink-0 items-center gap-1">{actions}</div>
    </li>
  );
}
