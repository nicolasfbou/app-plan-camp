import type { ReactNode } from 'react';

interface PageLayoutProps {
  breadcrumb?: ReactNode;
  title: string;
  subtitle?: string;
  action?: ReactNode;
  children: ReactNode;
}

export function PageLayout({ breadcrumb, title, subtitle, action, children }: PageLayoutProps) {
  return (
    <div className="h-full overflow-y-auto bg-panel">
      <div className="mx-auto max-w-4xl px-6 py-8">
        {breadcrumb && <nav className="mb-2 text-sm text-slate-500">{breadcrumb}</nav>}
        <div className="mb-6 flex items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold text-slate-900">{title}</h1>
            {subtitle && <p className="mt-1 text-sm text-slate-500">{subtitle}</p>}
          </div>
          {action}
        </div>
        {children}
      </div>
    </div>
  );
}

export function Notice({ tone = 'info', children }: { tone?: 'info' | 'error'; children: ReactNode }) {
  const styles =
    tone === 'error' ? 'border-red-200 bg-red-50 text-red-800' : 'border-slate-200 bg-white text-slate-600';
  return (
    <div
      role={tone === 'error' ? 'alert' : undefined}
      className={`rounded-lg border px-4 py-6 text-center text-sm ${styles}`}
    >
      {children}
    </div>
  );
}
