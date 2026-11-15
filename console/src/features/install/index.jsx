import { lazy } from 'react';
import { SIGNED_IN } from '@contracts/access.js';
// Clears the console's caches on sign-out and on a switch of business, tells the person when the phone is offline, and
// shows the iPhone's install hint: all of them start with the console.
import './live.js';

const InstallPage = lazy(() => import('./InstallPage.jsx'));

/**
 * Settings > Install the app (Phase 8, Q-12): the console as a web app on the home screen, for iPhone users until the iOS
 * app ships. No menu entry: the iPhone hint links here, and Android offers its own prompt.
 */
export default {
  name: 'install',
  access: SIGNED_IN,
  routes: [{ path: 'settings/install', element: <InstallPage /> }],
};
