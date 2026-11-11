/**
 * While the app is open, it asks the server every half minute whether its session still stands (P-08, F-47): a device
 * revoked in Settings > Devices, a family revoked for a reused refresh token or a person removed from the team is
 * signed out within a minute, even on a phone nobody is touching. Coming back to the app asks at once. In the
 * background nothing runs: the next call after the app returns does the same check.
 *
 * `appState` is react-native's AppState; `check` is session.check.
 */
export const HEARTBEAT_MS = 30_000;

export function startHeartbeat({ check, appState, intervalMs = HEARTBEAT_MS, setInterval: every = setInterval, clearInterval: stop = clearInterval }) {
  let timer = null;
  let running = false;
  const beat = async () => {
    if (running) return; // a slow answer is not asked over
    running = true;
    try {
      await check();
    } catch {
      // The session decides what a failure means; the heartbeat only keeps asking.
    } finally {
      running = false;
    }
  };
  const resume = () => {
    if (timer === null) timer = every(beat, intervalMs);
  };
  const pause = () => {
    if (timer !== null) stop(timer);
    timer = null;
  };

  if ((appState?.currentState ?? 'active') === 'active') resume();
  const subscription = appState?.addEventListener?.('change', (next) => {
    if (next === 'active') {
      beat();
      resume();
    } else pause();
  });

  return () => {
    pause();
    subscription?.remove?.();
  };
}
