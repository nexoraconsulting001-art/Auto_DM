import { lazy } from 'react';
import { SIGNED_IN } from '@contracts/access.js';

const SignupPage = lazy(() => import('./SignupPage.jsx'));

/**
 * Self-serve sign-up (PRD 5.20): Creator or Seller, connect Instagram, the guided first automation. It opens on the sign-in
 * host once the person has signed in there; the server finds the person from that session and answers 401 without one.
 * No menu entry: the person arrives by a link.
 */
export default {
  name: 'signup',
  access: SIGNED_IN,
  routes: [{ path: 'signup', element: <SignupPage /> }],
};
