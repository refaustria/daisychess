import { createContext, useContext } from 'react';
import type { PortalApi } from './api';
import type { Me } from './types';

export interface PortalContextValue {
  api: PortalApi;
  me: Me;
  /** Drops the session in the UI (after logout or a 401). */
  signedOut: () => void;
}

export const PortalContext = createContext<PortalContextValue | null>(null);

export function usePortal(): PortalContextValue {
  const v = useContext(PortalContext);
  if (!v) throw new Error('usePortal outside <PortalContext>');
  return v;
}
