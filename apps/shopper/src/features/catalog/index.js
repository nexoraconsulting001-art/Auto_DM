import LayoutGrid from 'lucide-react-native/icons/layout-grid';
import CatalogScreen from './CatalogScreen.js';

/**
 * Every product, with sorting and filters. Browsing needs no sign-in (P-27).
 * Not built yet: one placeholder screen. Whoever builds this replaces the screens below; the format is in ../index.js.
 */
export default {
  name: 'catalog',
  screens: [
    { name: 'index', path: 'shop', title: 'catalog.title', component: CatalogScreen, link: true },
  ],
  nav: { label: 'catalog.title', order: 20, icon: LayoutGrid },
  strings: { en: { 'catalog.title': 'Shop' }, hi: { 'catalog.title': 'दुकान' } },
};
