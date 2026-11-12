import { UserPlus } from 'lucide-react';
import { NotBuilt } from '../../NotBuilt.jsx';

/** The sign-up mode and invite codes (PRD 5.20). Routes: platform.signup, setSignupMode, signupInvites, createSignupInvite, revokeSignupInvite. */
function SignupPage() {
  return <NotBuilt title="Sign-up">The sign-up mode and invite codes (PRD 5.20).</NotBuilt>;
}

export default {
  name: 'signup',
  roles: ['super_admin', 'support'],
  nav: { to: '/signup', label: 'Sign-up', icon: UserPlus, order: 90 },
  routes: [{ path: 'signup', element: <SignupPage /> }],
};
