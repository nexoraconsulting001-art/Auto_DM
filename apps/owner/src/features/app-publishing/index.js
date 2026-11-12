import { OWNER_ONLY } from '@bhava/app-core/access';
import AppPublishingScreen from './AppPublishingScreen.js';

/**
 * Your app (PRD 10.7 to 10.14). The Phase 6 contract mapped its 17 seller routes here, on this placeholder screen, because the
 * parity check is strict and tools/parity-pending.json must stay empty; no menu entry until the console-apps track builds the
 * screens that call them, in this folder. The format is in ../index.js.
 */
export default {
  name: 'app-publishing',
  access: OWNER_ONLY,
  feature: 'app.android',
  routeIds: [
    'appPublishing.get', 'appPublishing.save', 'appPublishing.validate', 'appPublishing.builds', 'appPublishing.requestBuild', 'appPublishing.submissions',
    'appListing.get', 'appListing.save', 'appListing.assets',
    'storeAccess.get', 'storeAccess.save', 'storeAccess.check',
    'pushCampaigns.list', 'pushCampaigns.summary', 'pushCampaigns.send',
    'pushCredentials.get', 'pushCredentials.save',
  ],
  screens: [{ name: 'index', path: 'app-publishing', title: 'app-publishing.title', component: AppPublishingScreen }],
  nav: null,
  strings: { en: { 'app-publishing.title': 'Your app' }, hi: { 'app-publishing.title': 'आपका ऐप' } },
};
