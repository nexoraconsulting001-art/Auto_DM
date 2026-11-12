import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api/index.js';
import { googleStartsHere, passwordLoginOn, waysIn } from './signin.js';

export const OPTIONS_KEY = ['sign-in-options'];

/**
 * The ways in this server offers on this address (see waysIn in signin.js), from three questions asked at once: the
 * API's sign-in buttons (app.requirements, read as the Android app would, since it asks for a platform), whether the
 * Google start answers here (only on the sign-in host), and whether the password route exists (PASSWORD_LOGIN).
 * Nothing here throws: what cannot be learned is not offered, except WhatsApp, which is the way in.
 */
export async function signInOptions() {
  const [passwordRoute, requirements, signInHost] = await Promise.all([
    passwordLoginOn(),
    api.app.requirements({ platform: 'android' }).catch(() => null),
    googleStartsHere(),
  ]);
  return waysIn({ passwordRoute, requirements, signInHost });
}

export const useSignInOptions = () => useQuery({ queryKey: OPTIONS_KEY, queryFn: signInOptions, staleTime: Infinity, retry: false });
