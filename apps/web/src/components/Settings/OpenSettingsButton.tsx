import { openServerTokenSettings } from '../../server/tokenMessages';

/** Link-style button that opens the Settings tab and focuses the server access token field. */
export function OpenSettingsButton({ className, label = 'Open Settings' }: { className?: string; label?: string }) {
  return (
    <button type="button" className={className} data-testid="open-token-settings" onClick={openServerTokenSettings}>
      {label}
    </button>
  );
}
