import { SESSION_KEY, queryClient } from '../../lib/api/index.js';
import { createWorkspace } from './workspace.js';

function tabStorage() {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/**
 * The one workspace of this page (see workspace.js): installed when the console loads, before any screen asks the API
 * anything, because every feature module is loaded at start.
 */
export const workspace = createWorkspace({ target: window, storage: tabStorage(), queries: queryClient, sessionKey: SESSION_KEY });
workspace.start();
