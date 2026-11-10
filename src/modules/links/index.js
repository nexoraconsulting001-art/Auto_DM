import { notBuilt } from '../not-built.js';

/** PRD 4.11, 6.6, 6.13: direct links, UTM tags and per-reel measurement ids, link checks, and the two-tap "Send me the link" flow. */
export const links = {
  name: 'links',
  api: () => notBuilt('links.preview', 'links.check', 'links.taps', 'measurementIds.list', 'measurementIds.create', 'measurementIds.update', 'measurementIds.remove'),
};
