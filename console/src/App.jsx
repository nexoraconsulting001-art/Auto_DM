import { QueryClientProvider } from '@tanstack/react-query';
import { Outlet, RouterProvider, createBrowserRouter } from 'react-router-dom';
import { SELLER_ROLES, isAllowed } from '@contracts/access.js';
import { Button, EmptyState, Spinner } from './design/index.jsx';
import { features } from './features/index.js';
import { queryClient } from './lib/api/index.js';
import { SessionProvider, useSession } from './lib/session.jsx';
import { AppShell } from './shell/AppShell.jsx';
import { LoginPage } from './shell/LoginPage.jsx';

function CenteredPage({ children }) {
  return <div className="shell-centered">{children}</div>;
}

/** The session decides what shows: sign-in, a refusal, or the app. The address stays put, so a deep link survives signing in. */
function SignedIn() {
  const { status, session, retry, signOut } = useSession();
  if (status === 'loading') return <CenteredPage><Spinner label="Opening your console" /></CenteredPage>;
  if (status === 'error') {
    return (
      <CenteredPage>
        <EmptyState title="We couldn’t open your console" action={<Button onClick={retry}>Try again</Button>}>
          Check your connection and try again.
        </EmptyState>
      </CenteredPage>
    );
  }
  if (!session) return <LoginPage />;
  if (!SELLER_ROLES.includes(session.user.role)) {
    return (
      <CenteredPage>
        <EmptyState title="This account can’t open the console" action={<Button variant="soft" onClick={signOut}>Sign out</Button>}>
          It’s for the people who run this business. Ask the owner to add you.
        </EmptyState>
      </CenteredPage>
    );
  }
  return <AppShell><Outlet /></AppShell>;
}

function Allowed({ access, children }) {
  const { session } = useSession();
  if (isAllowed(session.user, access)) return children;
  return <EmptyState title="You don’t have access to this">Ask the owner of this business if you need it.</EmptyState>;
}

function NotFound() {
  return <EmptyState title="We couldn’t find that page">It may have moved. Use the menu to carry on.</EmptyState>;
}

const featureRoutes = features.flatMap((feature) =>
  feature.routes.map((route) => ({ ...route, element: <Allowed access={feature.access}>{route.element}</Allowed> })));

const router = createBrowserRouter(
  [{ path: '/', element: <SignedIn />, children: [...featureRoutes, { path: '*', element: <NotFound /> }] }],
  { basename: import.meta.env.BASE_URL.replace(/\/$/, '') },
);

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <SessionProvider>
        <RouterProvider router={router} />
      </SessionProvider>
    </QueryClientProvider>
  );
}
