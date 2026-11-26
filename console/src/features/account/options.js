import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api/index.js';
import { askWaysIn } from './signin.js';

export const OPTIONS_KEY = ['sign-in-options'];

/**
 * The ways in this server offers on this address (see waysIn in signin.js), from app.requirements alone: its sign-in
 * buttons and what a browser here can use (the sign-in host, the password route). Nothing here throws.
 */
export const signInOptions = () => askWaysIn(() => api.app.requirements({ platform: 'android' }));

export const useSignInOptions = () => useQuery({ queryKey: OPTIONS_KEY, queryFn: signInOptions, staleTime: Infinity, retry: false });
