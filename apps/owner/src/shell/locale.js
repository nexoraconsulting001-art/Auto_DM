/** The language chosen in Your account, kept in SecureStore across sign-outs, applied when the app opens. */
import { useEffect } from 'react';

export function useStoredLocale(store, strings) {
  useEffect(() => {
    let live = true;
    store?.getLocale?.().then((locale) => {
      if (live && locale && locale !== strings.getLocale()) strings.setLocale(locale);
    }).catch(() => {});
    return () => {
      live = false;
    };
  }, [store, strings]);
}
