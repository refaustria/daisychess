import { useEffect, useId, useRef, type ReactNode } from 'react';
import ui from '../ui.module.css';

interface DialogProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** Wide layout for secrets and snippets. */
  wide?: boolean;
}

/** Modal dialog: Escape closes, focus moves in and returns to the opener. */
export function Dialog({ title, onClose, children, wide }: DialogProps) {
  const titleId = useId();
  const ref = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    ref.current?.focus();
    return () => opener?.focus();
  }, []);

  return (
    <div className={ui.backdrop}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={wide ? `${ui.dialog} ${ui.dialogWide}` : ui.dialog}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            onCloseRef.current();
          }
        }}
      >
        <h2 id={titleId} className={ui.dialogTitle}>
          {title}
        </h2>
        {children}
      </div>
    </div>
  );
}

interface ConfirmProps {
  title: string;
  message: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({ title, message, confirmLabel, danger, busy, error, onConfirm, onCancel }: ConfirmProps) {
  return (
    <Dialog title={title} onClose={onCancel}>
      <div className={ui.stack}>
        <div>{message}</div>
        {error && (
          <p role="alert" className={ui.error}>
            {error}
          </p>
        )}
        <div className={ui.row}>
          <button type="button" className={danger ? ui.danger : ui.primary} disabled={busy} onClick={onConfirm}>
            {confirmLabel}
          </button>
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </Dialog>
  );
}
