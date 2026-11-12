import { ClipboardCheck } from 'lucide-react';
import { NotBuilt } from '../../NotBuilt.jsx';

/** The done-for-you workspace: the checklist, the invite and the operator timings (PRD 5.6). Routes: platform.onboardingList, onboarding, checkOnboarding, sendOnboardingInvite. */
function OnboardingPage() {
  return <NotBuilt title="Onboarding">The done-for-you workspace: the checklist, the invite and the operator timings (PRD 5.6).</NotBuilt>;
}

export default {
  name: 'onboarding',
  roles: ['super_admin', 'support', 'onboarding'],
  nav: { to: '/onboarding', label: 'Onboarding', icon: ClipboardCheck, order: 20 },
  routes: [{ path: 'onboarding', element: <OnboardingPage /> }],
};
