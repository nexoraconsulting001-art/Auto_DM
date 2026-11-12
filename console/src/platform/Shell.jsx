import { useRef } from 'react';
import { NavLink } from 'react-router-dom';
import { LogOut, Menu } from 'lucide-react';
import { Sheet } from '../design/index.jsx';
import { featureAllowed, features } from './features/index.js';
import { usePlatformSession } from './session.jsx';

const asset = (name) => `${import.meta.env.BASE_URL}${name}`;
const MAX_TABS = 4;
const ROLE_LABELS = { super_admin: 'Super admin', support: 'Support', onboarding: 'Onboarding', service_operator: 'Service operator' };

/**
 * The Platform Console's frame: Bhava's own tool, so only Bhava's brand appears. The menu is the feature registry
 * filtered by the signed-in person's role; the same layout classes as the seller console, so it works on a phone.
 */
export function Shell({ children }) {
  const { session, signOut } = usePlatformSession();
  const more = useRef(null);
  const items = features
    .filter((feature) => feature.nav && featureAllowed(feature, session.user))
    .map(({ nav }) => ({ to: nav.to, label: nav.label, Icon: nav.icon }));
  const tabs = items.slice(0, MAX_TABS);
  const rest = items.slice(MAX_TABS);
  const closeMore = () => more.current?.close();

  return (
    <div className="shell">
      <nav className="sidenav" aria-label="Main">
        <img className="sidenav-logo" src={asset('logo-white.svg')} alt="Bhava" width="104" height="26" />
        <div className="workspace">
          <span className="workspace-text">
            <span className="workspace-name">{session.user.name || session.user.email}</span>
            <span className="pc-role">{ROLE_LABELS[session.user.role] ?? session.user.role}</span>
          </span>
        </div>
        <ul className="sidenav-list">
          {items.map(({ to, label, Icon }) => (
            <li key={to}>
              <NavLink className="sidenav-link" to={to}>
                <Icon size={20} strokeWidth={1.7} aria-hidden="true" />
                {label}
              </NavLink>
            </li>
          ))}
        </ul>
        <button type="button" className="sidenav-link sidenav-signout" onClick={signOut}>
          <LogOut size={20} strokeWidth={1.7} aria-hidden="true" />
          Sign out
        </button>
      </nav>
      <div className="shell-body">
        <header className="shell-top">
          <span className="workspace-name">Bhava Console</span>
          <img className="shell-mark" src={asset('favicon.svg')} alt="Bhava" width="32" height="32" />
        </header>
        <main className="shell-content">{children}</main>
      </div>
      <nav className="tabbar" aria-label="Main">
        {tabs.map(({ to, label, Icon }) => (
          <NavLink key={to} className="tabbar-link" to={to} aria-label={label}>
            <Icon size={21} strokeWidth={1.7} aria-hidden="true" />
            <span className="tabbar-label">{label}</span>
          </NavLink>
        ))}
        <button type="button" className="tabbar-link" aria-label="More" onClick={() => more.current?.showModal()}>
          <Menu size={21} strokeWidth={1.7} aria-hidden="true" />
        </button>
      </nav>
      <Sheet ref={more} title="More">
        <ul className="sheet-list">
          {rest.map(({ to, label, Icon }) => (
            <li key={to}>
              <NavLink className="sheet-link" to={to} onClick={closeMore}>
                <Icon size={20} strokeWidth={1.7} aria-hidden="true" />
                {label}
              </NavLink>
            </li>
          ))}
          <li>
            <button type="button" className="sheet-link" onClick={() => { closeMore(); signOut(); }}>
              <LogOut size={20} strokeWidth={1.7} aria-hidden="true" />
              Sign out
            </button>
          </li>
        </ul>
      </Sheet>
    </div>
  );
}
