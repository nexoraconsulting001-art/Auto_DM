import Zap from 'lucide-react-native/icons/zap';
import { staffWith } from '@bhava/app-core/access';
import AutomationsScreen from './AutomationsScreen.js';
import BuilderScreen from './BuilderScreen.js';
import IceBreakersScreen from './IceBreakersScreen.js';
import strings from './strings.js';

/**
 * DM automations (the console's /automations and /automations/:id, PRD 6): the list, and the builder with where it
 * runs, keywords, variants, the link, the schedule, test mode with testers, the dry run, the numbers and the winner;
 * and the ice breakers. Staff with the automations permission use it, as on the web; adding and removing testers is
 * the owner's and managers', and the server refuses anyone else again. The plan must include automations.
 */
export default {
  name: 'automations',
  access: staffWith('automations'),
  feature: 'automations',
  routeIds: [
    'automations.list', 'automations.create', 'automations.preview', 'automations.get', 'automations.update', 'automations.remove', 'automations.setState',
    'automations.pickWinner', 'automations.stats', 'automations.sendTest', 'testers.list', 'testers.createCode', 'testers.remove', 'iceBreakers.get', 'iceBreakers.save',
    'instagram.connection', 'instagram.media', 'links.preview', 'measurementIds.list', 'measurementIds.create', 'measurementIds.update', 'measurementIds.remove',
    'brandKit.get', 'compliance.status', 'facebook.connection',
    'console:/automations', 'console:/automations/:id',
  ],
  screens: [
    { name: 'index', path: 'automations', title: 'automations.title', component: AutomationsScreen },
    { name: 'detail', path: 'automations/:id', title: 'automations.edit', component: BuilderScreen },
    { name: 'iceBreakers', path: 'automations/ice-breakers', title: 'automations.ice.title', component: IceBreakersScreen },
  ],
  nav: { label: 'automations.title', order: 31, icon: Zap },
  strings,
};
