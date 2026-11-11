/**
 * What the shell hands its screens beside the services: the way to open a path ("/orders/12") as a push or a link
 * would, and the navigation worked out for this person. A feature opens a record with `useOpenLink()(path)`; the
 * router switches business first when it names another one, and opens nothing the person may not open.
 */
import { createContext, useContext } from 'react';

export const ShellContext = createContext({ openLink: () => Promise.resolve('ignored'), nav: { tabs: [], more: [], screens: [] } });

export const useOpenLink = () => useContext(ShellContext).openLink;
export const useShellNav = () => useContext(ShellContext).nav;
