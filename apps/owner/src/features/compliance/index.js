import ShieldCheck from 'lucide-react-native/icons/shield-check';
import { staffWith } from '@bhava/app-core/access';
import ComplianceScreen from './ComplianceScreen.js';
import ComplianceLogScreen from './ComplianceLogScreen.js';
import ComplianceSettingsScreen from './ComplianceSettingsScreen.js';
import strings from './strings.js';

/**
 * Sending rules (PRD 4, the console's Compliance): the status and the pause switch, slow mode, held messages, Meta's
 * checks, the log of every decision with its reason, and the rules and word lists. Reading needs the automations
 * permission, as on the web; pausing, resuming and changing rules are the owner's and managers', and the server
 * refuses anyone else again. reasons.js holds the engine's words that every other screen shows a refusal with.
 */
export default {
  name: 'compliance',
  access: staffWith('automations'),
  feature: null,
  routeIds: [
    'compliance.status', 'compliance.pause', 'compliance.resume', 'compliance.settings', 'compliance.updateSettings', 'compliance.activity',
    'compliance.heldJobs', 'compliance.discardHeld', 'compliance.slowModeOverride', 'compliance.words', 'compliance.addWord', 'compliance.removeWord',
    'instagram.connection', 'facebook.connection',
    'console:/compliance', 'console:/compliance/log', 'console:/compliance/settings',
  ],
  screens: [
    { name: 'index', path: 'compliance', title: 'compliance.title', component: ComplianceScreen },
    { name: 'log', path: 'compliance/log', title: 'compliance.log.title', component: ComplianceLogScreen },
    { name: 'rules', path: 'compliance/settings', title: 'compliance.rules.title', component: ComplianceSettingsScreen },
  ],
  nav: { label: 'compliance.title', order: 64, icon: ShieldCheck },
  strings,
};
