import { ClipboardCheck } from 'lucide-react';
import { screen } from '../../lazy.js';

const load = () => import('./pages.jsx');
const OnboardingPage = screen(load, 'OnboardingPage');
const OnboardingWorkspacePage = screen(load, 'OnboardingWorkspacePage');

export default {
  name: 'onboarding',
  roles: ['super_admin', 'support', 'onboarding'],
  nav: { to: '/onboarding', label: 'Onboarding', icon: ClipboardCheck, order: 20 },
  routes: [
    { path: 'onboarding', element: <OnboardingPage /> },
    { path: 'onboarding/:id', element: <OnboardingWorkspacePage /> },
  ],
};
