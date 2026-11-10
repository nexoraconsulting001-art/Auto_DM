import { useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { NavLink } from 'react-router-dom';
import { LogOut, Menu } from 'lucide-react';
import { isAllowed, staffWith } from '@contracts/access.js';
import { Avatar, Sheet } from '../design/index.jsx';
import { features } from '../features/index.js';
import { api } from '../lib/api/index.js';
import { useSession } from '../lib/session.jsx';

const asset = (name) => `${import.meta.env.BASE_URL}${name}`;
const MAX_TABS = 4;

/** The seller's logo appears only here, as the workspace identity. Everything else in the console is Bhava's. */
function Workspace({ business, plan = true }) {
  return (
    <div className="workspace">
      <Avatar name={business.name} src={business.logoUrl} />
      <span className="workspace-text">
        <span className="workspace-name">{business.name}</span>
        {plan && <span className="workspace-plan">{business.plan}</span>}
      </span>
    </div>
  );
}

function SideNav({ items, business, onSignOut }) {
  return (
    <nav className="sidenav" aria-label="Main">
      <img className="sidenav-logo" src={asset('logo-white.svg')} alt="Bhava" width="104" height="26" />
      <Workspace business={business} />
      <ul className="sidenav-list">
        {items.map(({ to, label, end, Icon, count }) => (
          <li key={to}>
            <NavLink className="sidenav-link" to={to} end={end}>
              <Icon size={20} strokeWidth={1.7} aria-hidden="true" />
              {label}
              {count > 0 && <span className="nav-count">{count}</span>}
            </NavLink>
          </li>
        ))}
      </ul>
      <button type="button" className="sidenav-link sidenav-signout" onClick={onSignOut}>
        <LogOut size={20} strokeWidth={1.7} aria-hidden="true" />
        Sign out
      </button>
    </nav>
  );
}

function TabBar({ items, onSignOut }) {
  const more = useRef(null);
  const tabs = items.filter((item) => item.primary).slice(0, MAX_TABS);
  const rest = items.filter((item) => !tabs.includes(item));
  const closeMore = () => more.current?.close();

  return (
    <>
      <nav className="tabbar" aria-label="Main">
        {tabs.map(({ to, label, end, Icon, count }) => (
          <NavLink key={to} className="tabbar-link" to={to} end={end} aria-label={count > 0 ? `${label}, ${count} waiting` : label}>
            <Icon size={21} strokeWidth={1.7} aria-hidden="true" />
            <span className="tabbar-label">{label}</span>
            {count > 0 && <span className="tabbar-dot" aria-hidden="true" />}
          </NavLink>
        ))}
        <button type="button" className="tabbar-link" aria-label="More" onClick={() => more.current?.showModal()}>
          <Menu size={21} strokeWidth={1.7} aria-hidden="true" />
        </button>
      </nav>
      <Sheet ref={more} title="More">
        <ul className="sheet-list">
          {rest.map(({ to, label, end, Icon }) => (
            <li key={to}>
              <NavLink className="sheet-link" to={to} end={end} onClick={closeMore}>
                <Icon size={20} strokeWidth={1.7} aria-hidden="true" />
                {label}
              </NavLink>
            </li>
          ))}
          <li>
            <button type="button" className="sheet-link" onClick={() => { closeMore(); onSignOut(); }}>
              <LogOut size={20} strokeWidth={1.7} aria-hidden="true" />
              Sign out
            </button>
          </li>
        </ul>
      </Sheet>
    </>
  );
}

export function AppShell({ children }) {
  const { session, signOut } = useSession();
  // The menu's counts come from the dashboard numbers. Without them, or without access to them, there are simply no counts.
  const stats = useQuery({ queryKey: ['stats'], queryFn: api.stats.dashboard, enabled: isAllowed(session.user, staffWith('analytics')) });
  const items = features
    .filter((feature) => feature.nav && isAllowed(session.user, feature.access))
    .map(({ nav }) => ({ to: nav.to, end: nav.to === '/', label: nav.label, Icon: nav.icon, primary: nav.primary, count: stats.data && nav.count ? nav.count(stats.data) : 0 }));

  return (
    <div className="shell">
      <SideNav items={items} business={session.business} onSignOut={signOut} />
      <div className="shell-body">
        <header className="shell-top">
          <Workspace business={session.business} plan={false} />
          <img className="shell-mark" src={asset('favicon.svg')} alt="Bhava" width="32" height="32" />
        </header>
        <main className="shell-content">{children}</main>
      </div>
      <TabBar items={items} onSignOut={signOut} />
    </div>
  );
}
