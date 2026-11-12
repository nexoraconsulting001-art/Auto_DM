import LayoutGrid from 'lucide-react-native/icons/layout-grid';
import CatalogScreen from './CatalogScreen.js';

/** The whole shop: every product the server shows, by category and sort. */
export default {
  name: 'catalog',
  screens: [
    { name: 'index', path: 'shop', title: 'catalog.title', component: CatalogScreen, link: true },
  ],
  nav: { label: 'catalog.title', order: 20, icon: LayoutGrid },
  strings: {
    en: {
      'catalog.title': 'Shop',
      'catalog.all': 'All',
      'catalog.sort': 'Sort by',
      'catalog.sort.popular': 'Popular',
      'catalog.sort.newest': 'Newest',
      'catalog.sort.price-asc': 'Price: low to high',
      'catalog.sort.price-desc': 'Price: high to low',
      'catalog.sort.discount': 'Biggest discount',
      'catalog.empty': 'Nothing here yet',
    },
    hi: {
      'catalog.title': 'दुकान',
      'catalog.all': 'सभी',
      'catalog.sort': 'क्रम',
      'catalog.sort.popular': 'लोकप्रिय',
      'catalog.sort.newest': 'नया',
      'catalog.sort.price-asc': 'कीमत: कम से ज़्यादा',
      'catalog.sort.price-desc': 'कीमत: ज़्यादा से कम',
      'catalog.sort.discount': 'सबसे ज़्यादा छूट',
      'catalog.empty': 'अभी यहाँ कुछ नहीं है',
    },
  },
};
