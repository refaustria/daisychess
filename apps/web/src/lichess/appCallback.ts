// Side-effect module (imported from main.tsx before the app URL routing starts): routes the app's
// lichess OAuth callback (`org.daisychess.app://lichess-callback?code=&state=`, M26-2) from the
// app URL dispatcher to the login store. Only in the mobile build; the web gets the callback as
// the page URL (`handleCallback()` in main.tsx).
import { registerAppUrlHandler } from '../platform/appUrl';
import { handleLichessCallback, isLichessCallbackUrl } from './auth';

if (import.meta.env.MODE === 'mobile') {
  registerAppUrlHandler(isLichessCallbackUrl, (url) => void handleLichessCallback(url));
}
