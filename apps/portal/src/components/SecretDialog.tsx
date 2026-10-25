import type { ReactNode } from 'react';
import ui from '../ui.module.css';
import { CopyField } from './CopyField';
import { Dialog } from './Dialog';
import { QrCode } from './QrCode';

interface Props {
  title: string;
  /** What the secret is, e.g. "Node token". */
  secretLabel: string;
  secret: string;
  setupLink?: string | null;
  children?: ReactNode;
  onClose: () => void;
}

/**
 * Shows a credential exactly once. The secret lives only in the props of this dialog (the caller
 * holds it in component state and drops it in `onClose`); it is never written to storage.
 */
export function SecretDialog({ title, secretLabel, secret, setupLink, children, onClose }: Props) {
  return (
    <Dialog title={title} onClose={onClose} wide>
      <div className={ui.stack}>
        <p className={ui.warn} role="note">
          This is the only time the {secretLabel.toLowerCase()} is shown. Copy it now and keep it secret; if you lose it,
          create or rotate a new one.
        </p>
        <CopyField label={secretLabel} value={secret} />
        {setupLink && (
          <>
            <CopyField label="Setup link" value={setupLink} />
            <p className={ui.muted}>Open the link on the device that should use this token (or scan the code with it).</p>
            <div className={ui.qr}>
              <QrCode text={setupLink} label="QR code of the setup link" />
            </div>
          </>
        )}
        {children}
        <div className={ui.row}>
          <button type="button" className={ui.primary} onClick={onClose}>
            I have copied it, close
          </button>
        </div>
      </div>
    </Dialog>
  );
}
