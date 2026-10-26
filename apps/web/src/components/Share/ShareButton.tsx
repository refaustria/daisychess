import { canShare, shareContent, type ShareContent, type ShareResult } from '../../platform/share';

interface Props {
  content: ShareContent | (() => ShareContent);
  label?: string;
  className?: string;
  disabled?: boolean;
  testId?: string;
  /** Reports the outcome ('cancelled' needs no message). */
  onResult?: (r: ShareResult) => void;
}

/** Opens the share sheet (native app, or the browser's Web Share API); renders nothing where there is none. */
export function ShareButton({
  content,
  label = 'Share',
  className,
  disabled,
  testId,
  onResult,
}: Props) {
  if (!canShare()) return null;
  return (
    <button
      type="button"
      className={className}
      disabled={disabled}
      data-testid={testId}
      onClick={() =>
        void shareContent(typeof content === 'function' ? content() : content).then(onResult)
      }
    >
      {label}
    </button>
  );
}
