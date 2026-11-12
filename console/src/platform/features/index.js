/**
 * Every part of the Platform Console registers itself, as the seller console's features do, so parallel work never touches
 * a shared list. Create console/src/platform/features/<name>/index.jsx and default-export:
 *
 *   {
 *     name: 'health',
 *     roles: ['super_admin', 'support'],     // platform roles that see the menu entry and may open the pages
 *     nav: { to: '/health', label: 'Health', icon: HeartPulse, order: 30 },      // leave out for no menu entry
 *     routes: [{ path: 'health', element: <HealthPage /> }, { path: 'health/:id', element: <BusinessHealthPage /> }],
 *   }
 *
 * Paths are relative to /console. Use React.lazy for pages so each feature loads only when opened. The data comes from
 * `api` in ../api.js, which is built from the route table; the server checks the role again on every call, so hiding an
 * entry here is never the only guard. Nothing in this folder is imported by the seller console, and nothing of a
 * seller's brand appears here: this is Bhava's own tool.
 */
const found = import.meta.glob('./*/index.jsx', { eager: true });

export const features = Object.values(found)
  .map((module) => module.default)
  .sort((a, b) => (a.nav?.order ?? 999) - (b.nav?.order ?? 999));

export const featureAllowed = (feature, user) => Boolean(user) && feature.roles.includes(user.role);
