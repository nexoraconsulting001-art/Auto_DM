import { Component, Suspense } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { Navigate, Outlet, RouterProvider, createBrowserRouter, useLocation } from 'react-router-dom';
import { Button, EmptyState, Spinner } from '../design/index.jsx';
import { queryClient } from './api.js';
import { featureAllowed, features } from './features/index.js';
import { PlatformSessionProvider, usePlatformSession } from './session.jsx';
import { Shell } from './Shell.jsx';
import { SignIn } from './SignIn.jsx';

/** A screen that cannot render costs that screen and not the whole console. */
class ScreenBoundary extends Component {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <EmptyState title="This page didn’t load" action={<Button onClick={() => window.location.reload()}>Reload</Button>}>
        Check your connection and reload the page.
      </EmptyState>
    );
  }
}

function Screen() {
  const { pathname } = useLocation();
  return (
    <ScreenBoundary key={pathname}>
      <Suspense fallback={<Spinner label="Opening this page" />}>
        <Outlet />
      </Suspense>
    </ScreenBoundary>
  );
}

function Centered({ children }) {
  return <div className="shell-centered">{children}</div>;
}

/** The session decides what shows: sign-in or the console. The address stays put, so a deep link survives signing in. */
function SignedIn() {
  const { status, session, retry } = usePlatformSession();
  if (status === 'loading') return <Centered><Spinner label="Opening the console" /></Centered>;
  if (status === 'error') {
    return (
      <Centered>
        <EmptyState title="We couldn’t open the console" action={<Button onClick={retry}>Try again</Button>}>
          Check your connection and try again.
        </EmptyState>
      </Centered>
    );
  }
  if (!session) return <SignIn />;
  return <Shell><Screen /></Shell>;
}

function Allowed({ feature, children }) {
  const { session } = usePlatformSession();
  if (featureAllowed(feature, session.user)) return children;
  return <EmptyState title="Your role doesn’t include this">Ask a super admin if you need it.</EmptyState>;
}

/** The first screen is the first thing this role may open. */
function Home() {
  const { session } = usePlatformSession();
  const first = features.find((feature) => feature.nav && featureAllowed(feature, session.user));
  if (first) return <Navigate to={first.nav.to} replace />;
  return <EmptyState title="Nothing here for your role yet">Ask a super admin to check your role.</EmptyState>;
}

function NotFound() {
  return <EmptyState title="We couldn’t find that page">Use the menu to carry on.</EmptyState>;
}

const featureRoutes = features.flatMap((feature) =>
  feature.routes.map((route) => ({ ...route, element: <Allowed feature={feature}>{route.element}</Allowed> })));

const router = createBrowserRouter(
  [{ path: '/', element: <SignedIn />, children: [{ index: true, element: <Home /> }, ...featureRoutes, { path: '*', element: <NotFound /> }] }],
  { basename: import.meta.env.BASE_URL.replace(/\/$/, '') },
);

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <PlatformSessionProvider>
        <RouterProvider router={router} />
      </PlatformSessionProvider>
    </QueryClientProvider>
  );
}
