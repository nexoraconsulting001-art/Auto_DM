import ShoppingBag from 'lucide-react-native/icons/shopping-bag';
import { staffWith } from '@bhava/app-core/access';
import OrdersScreen from './OrdersScreen.js';
import OrderScreen from './OrderScreen.js';
import OrderFilesScreen from './OrderFilesScreen.js';
import ShipmentScreen from './ShipmentScreen.js';
import strings from './strings.js';

/**
 * Orders (PRD 9.9, 10.4; P-18, P-19): the list, one order with its next step, parcels, payments, refunds, invoices,
 * the customer's messages and the timeline, a parcel's journey, and orders as a file. The status words every store
 * screen uses live here (orders.status.<group>.<status>), and the store screens' shared kit is ./kit.
 */
export default {
  name: 'orders',
  access: staffWith('orders'),
  feature: 'store.checkout',
  routeIds: [
    'orders.list', 'orders.get', 'orders.setStatus', 'orders.timeline', 'orders.advance', 'orders.cancel', 'orders.releaseHold', 'orders.reinstate', 'orders.addNote',
    'orderDownloads.list', 'orderDownloads.create', 'orderDownloads.get',
    'shipments.forOrder', 'shipments.create', 'shipments.get', 'shipments.cancel', 'shipments.label',
    'payments.forOrder', 'refunds.forOrder', 'invoices.list', 'orderAlerts.list', 'orderAlerts.retry',
    'console:/orders', 'console:/orders/:id', 'console:/orders/files',
  ],
  screens: [
    { name: 'index', path: 'orders', title: 'orders.title', component: OrdersScreen },
    { name: 'files', path: 'orders/files', title: 'orders.files.title', component: OrderFilesScreen },
    { name: 'detail', path: 'orders/:id', title: 'orders.detail', component: OrderScreen },
    { name: 'shipment', path: 'shipments/:id', title: 'orders.shipment', component: ShipmentScreen },
  ],
  nav: { label: 'orders.title', order: 10, icon: ShoppingBag, primary: true },
  strings,
};
