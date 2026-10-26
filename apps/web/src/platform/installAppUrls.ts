// Side-effect module (imported from main.tsx): registers the built-in app URL routes on the real
// stores and starts listening in the native shell. Does nothing on the web.
import { setupActions } from '../setup/runSetupLink';
import { consumeSetupLink } from '../setup/setupLink';
import { installAppUrlRouting, registerBuiltinAppUrlHandlers } from './appUrl';

registerBuiltinAppUrlHandlers({
  setup: (hash) =>
    void consumeSetupLink({
      location: { hash, pathname: '', search: '' },
      history: { state: null, replaceState: () => undefined },
      ...setupActions,
    }),
  // The Friend tab follows the hash (installRoomRoute); an identical hash fires no event, so
  // clear it first.
  room: (hash) => {
    if (globalThis.location.hash === hash)
      globalThis.history.replaceState(null, '', globalThis.location.pathname);
    globalThis.location.hash = hash;
  },
});
void installAppUrlRouting().catch(() => undefined);
