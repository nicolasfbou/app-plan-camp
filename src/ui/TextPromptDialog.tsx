import { type ReactNode, useState } from 'react';
import { t } from '@/i18n/index.ts';
import { Button } from './Button.tsx';
import { Modal } from './Modal.tsx';

interface TextPromptDialogProps {
  title: string;
  label: string;
  initialValue: string;
  confirmLabel: string;
  onConfirm(value: string): void;
  onCancel(): void;
  children?: ReactNode;
}

/** Saisie d'un nom (camp, plan). Monter le composant ouvre la boîte ; le démonter la ferme. */
export function TextPromptDialog({
  title,
  label,
  initialValue,
  confirmLabel,
  onConfirm,
  onCancel,
  children,
}: TextPromptDialogProps) {
  const [value, setValue] = useState(initialValue);
  const trimmed = value.trim();
  const submit = () => trimmed && onConfirm(trimmed);

  return (
    <Modal
      open
      title={title}
      onClose={onCancel}
      footer={
        <>
          <Button onClick={onCancel}>{t('common.cancel')}</Button>
          <Button variant="primary" disabled={!trimmed} onClick={submit}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
        className="space-y-3"
      >
        <label className="block">
          <span className="mb-1 block font-medium text-slate-800">{label}</span>
          <input
            autoFocus
            value={value}
            maxLength={120}
            onChange={(event) => setValue(event.target.value)}
            onFocus={(event) => event.target.select()}
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-accent focus:outline-none"
          />
        </label>
        {children}
      </form>
    </Modal>
  );
}
