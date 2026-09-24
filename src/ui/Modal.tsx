import { type ReactNode, useEffect, useRef } from 'react';

interface ModalProps {
  open: boolean;
  title: string;
  onClose(): void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}

/** Boîte de dialogue modale basée sur <dialog> (focus, Échap et arrière-plan inerte natifs). */
export function Modal({ open, title, onClose, children, footer, wide = false }: ModalProps) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault();
        // Échap ne ferme que cette boîte, jamais une boîte qui la contient.
        event.stopPropagation();
        onClose();
      }}
      className={`m-auto w-[calc(100%-2rem)] rounded-lg bg-white p-0 shadow-xl backdrop:bg-slate-900/50 ${wide ? 'max-w-3xl' : 'max-w-md'}`}
    >
      {open && (
        <div className="flex max-h-[85vh] flex-col">
          <h2 className="border-b border-slate-200 px-5 py-3 text-base font-semibold text-slate-900">
            {title}
          </h2>
          <div className="overflow-y-auto px-5 py-4 text-sm text-slate-700">{children}</div>
          {footer && (
            <div className="flex justify-end gap-2 border-t border-slate-200 px-5 py-3">{footer}</div>
          )}
        </div>
      )}
    </dialog>
  );
}
