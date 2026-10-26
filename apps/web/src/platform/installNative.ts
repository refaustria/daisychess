// Side-effect-free entry (called from main.tsx): starts the native polish of M26-4. Every part is
// a no-op on the web (the plugin loaders return null there).
import { installBackButton } from './backButton';
import { installHaptics } from './haptics';
import { installKeepAwake } from './keepAwake';
import { installLifecycle } from './lifecycle';
import { installStatusBarTheme } from './statusBar';

export function installNative(): void {
  for (const install of [
    installHaptics,
    installKeepAwake,
    installStatusBarTheme,
    installBackButton,
    installLifecycle,
  ])
    void install().catch(() => undefined);
}
