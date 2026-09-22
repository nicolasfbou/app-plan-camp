import type { ReactNode } from 'react';
import { t } from '@/i18n/index.ts';
import { Button } from './Button.tsx';
import { Modal } from './Modal.tsx';
import { useSubmit } from './useSubmit.ts';

interface ConfirmDialogProps {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  onConfirm(): Promise<void> | void;
  onCancel(): void;
}

export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  danger = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const { busy, error, submit } = useSubmit();
  return (
    <Modal
      open
      title={title}
      onClose={onCancel}
      footer={
        <>
          <Button onClick={onCancel} autoFocus>
            {t('common.cancel')}
          </Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            disabled={busy}
            onClick={() => void submit(onConfirm)}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
      {error && (
        <p role="alert" className="mt-3 text-sm text-red-700">
          {error}
        </p>
      )}
    </Modal>
  );
}
