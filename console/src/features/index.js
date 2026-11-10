/**
 * Every part of the console registers itself, so parallel work never touches a shared list. Create
 * console/src/features/<name>/index.jsx and default-export:
 *
 *   {
 *     name: 'products',
 *     access: staffWith('catalog'),        // from @contracts/access.js: hides the menu entry and refuses the pages
 *     nav: { to: '/products', label: 'Products', icon: Package, order: 20, primary: true },   // leave out for no menu entry
 *     routes: [{ path: 'products', element: <ProductsPage /> }, { path: 'products/:id', element: <ProductPage /> }],
 *   }
 *
 * `primary` puts the entry in the phone's tab bar (the first four); the rest go under More. Paths are relative
 * to /admin. Use React.lazy for pages so each feature loads only when opened.
 */
const found = import.meta.glob('./*/index.jsx', { eager: true });

export const features = Object.values(found)
  .map((module) => module.default)
  .sort((a, b) => (a.nav?.order ?? 999) - (b.nav?.order ?? 999));
