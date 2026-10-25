import ui from '../ui.module.css';

const TONE: Record<string, string> = {
  online: ui.ok ?? '',
  active: ui.ok ?? '',
  draining: ui.warning ?? '',
  suspect: ui.warning ?? '',
  offline: ui.muted ?? '',
  expired: ui.muted ?? '',
  revoked: ui.bad ?? '',
  disabled: ui.bad ?? '',
};

/** Status as text plus colour (never colour alone). */
export function Badge({ status }: { status: string }) {
  return <span className={`${ui.badge} ${TONE[status] ?? ''}`}>{status}</span>;
}
