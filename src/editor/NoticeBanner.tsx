import { X } from 'lucide-react';
import { useEffect } from 'react';
import { t } from '@/i18n/index.ts';
import { useEditorStore } from '@/store/editorStore.ts';

/** Message bref (action refusée…), en haut de la zone de travail ; disparaît après quelques secondes. */
export function NoticeBanner() {
  const notice = useEditorStore((s) => s.notice);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => useEditorStore.getState().notify(null), 7000);
    return () => clearTimeout(timer);
  }, [notice]);
  if (!notice) return null;
  return (
    <div
      role="status"
      data-testid="notice"
      className="absolute inset-x-0 top-3 z-30 mx-auto flex w-fit max-w-xl items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 shadow"
    >
      <span>{notice}</span>
      <button
        type="button"
        aria-label={t('notice.close')}
        onClick={() => useEditorStore.getState().notify(null)}
        className="rounded p-0.5 hover:bg-amber-100"
      >
        <X size={14} />
      </button>
    </div>
  );
}
