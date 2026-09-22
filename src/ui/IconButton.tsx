import type { ReactNode } from 'react';

interface IconButtonProps {
  label: string;
  onClick(): void;
  disabled?: boolean;
  pressed?: boolean;
  children: ReactNode;
}

/** Bouton icône accessible : le libellé sert d'infobulle et de nom accessible. */
export function IconButton({ label, onClick, disabled = false, pressed, children }: IconButtonProps) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      className="inline-flex h-8 w-8 items-center justify-center rounded-md text-slate-700 hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:text-slate-300 disabled:hover:bg-transparent"
    >
      {children}
    </button>
  );
}
