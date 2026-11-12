/**
 * Pure: what the registry means for the navigator. No React, so the server's tests load it too.
 *
 *   screenName(feature, screen)   the navigator's name for a screen: '<feature>.<name>'
 *   tabsOf(features)              the features with a tab, in order
 *   checkFeature(feature)         what is wrong with a feature's registration, as sentences; [] when sound
 *   linkPathsOf(features)         every path of the store's website that opens a screen, as '/p/*' patterns
 *   linkingOf(features, brand)    React Navigation's linking config: the brand's link scheme and its own hosts
 */
export const MAX_TABS = 5;
export const TABS = 'tabs';

export const screenName = (feature, screen) => `${feature.name}.${screen.name}`;

export const tabsOf = (features) => features.filter((feature) => feature.nav).sort((a, b) => a.nav.order - b.nav.order);

const FEATURE_NAME = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const SCREEN_PATH = /^$|^[a-z0-9-]+(\/(:[A-Za-z]+|[a-z0-9-]+))*$/;

export function checkFeature(feature) {
  const problems = [];
  const name = feature?.name;
  if (typeof name !== 'string' || !FEATURE_NAME.test(name)) return [`a feature has no usable name (${String(name)})`];
  if (!Array.isArray(feature.screens) || feature.screens.length === 0) problems.push(`${name}: needs at least one screen`);
  const seen = new Set();
  for (const screen of feature.screens ?? []) {
    if (typeof screen.name !== 'string' || !/^[A-Za-z][A-Za-z0-9]*$/.test(screen.name)) problems.push(`${name}: a screen has no usable name`);
    else if (seen.has(screen.name)) problems.push(`${name}: two screens are named ${screen.name}`);
    seen.add(screen.name);
    if (typeof screen.path !== 'string' || !SCREEN_PATH.test(screen.path)) problems.push(`${name}.${screen.name}: path must look like 'p/:slug'`);
    if (typeof screen.title !== 'string' || !screen.title) problems.push(`${name}.${screen.name}: needs a title key`);
    if (typeof screen.component !== 'function') problems.push(`${name}.${screen.name}: needs a component`);
    if ('link' in screen && typeof screen.link !== 'boolean') problems.push(`${name}.${screen.name}: link is true or false`);
  }
  if (feature.nav !== null) {
    const nav = feature.nav;
    if (!nav || typeof nav.label !== 'string' || !Number.isFinite(nav.order) || !nav.icon) problems.push(`${name}: nav is null, or { label, order, icon }`);
  }
  for (const locale of ['en', 'hi']) {
    for (const key of Object.keys(feature.strings?.[locale] ?? {})) if (!key.startsWith(`${name}.`)) problems.push(`${name}: the string key ${key} must start with "${name}."`);
  }
  if (feature.service !== undefined && typeof feature.service !== 'function') problems.push(`${name}: service is a function`);
  return problems;
}

/** 'p/:slug' as the server lists it: '/p/*'. The home screen's '' is '/'. */
export const linkPattern = (path) => `/${path.split('/').map((part) => (part.startsWith(':') ? '*' : part)).join('/')}`;

export const linkPathsOf = (features) => features.flatMap((feature) => feature.screens.filter((screen) => screen.link).map((screen) => linkPattern(screen.path)));

/**
 * The same direct link a message carries opens the app: https on the brand's own hosts, and the brand's link scheme. Only
 * screens marked `link` are reachable from outside; everything else is opened from inside the app.
 */
export function linkingOf(features, brand) {
  const tabNames = new Set(tabsOf(features).map((feature) => screenName(feature, feature.screens[0])));
  const tabScreens = {};
  const screens = {};
  for (const feature of features) {
    for (const screen of feature.screens) {
      if (!screen.link) continue;
      const id = screenName(feature, screen);
      (tabNames.has(id) ? tabScreens : screens)[id] = screen.path;
    }
  }
  return {
    prefixes: [`${brand.scheme}://`, ...(brand.linkHosts ?? []).map((host) => `https://${host}`)],
    config: { screens: { [TABS]: { screens: tabScreens }, ...screens } },
  };
}
