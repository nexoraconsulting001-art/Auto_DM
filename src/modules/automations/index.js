import { notBuilt } from '../not-built.js';

/** PRD 6.1 to 6.5, 6.7 to 6.9: automations and their variants, the keyword matcher, testers, ice breakers and the owner inbox. */
export const automations = {
  name: 'automations',
  api: () => notBuilt(
    'automations.list', 'automations.create', 'automations.get', 'automations.update', 'automations.remove', 'automations.setState', 'automations.pickWinner',
    'automations.stats', 'automations.sendTest', 'automations.preview',
    'testers.list', 'testers.createCode', 'testers.remove',
    'iceBreakers.get', 'iceBreakers.save',
    'inbox.threads', 'inbox.thread', 'inbox.reply', 'inbox.needsHuman', 'inbox.resolve',
  ),
};
