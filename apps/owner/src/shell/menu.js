/**
 * The navigation, worked out from the feature registry. Pure functions, so they are tested without a device:
 * which features this person may open, which four sit in the tab bar, what a deep link opens.
 */
import { matchPath } from '@bhava/app-core';
import { ACCOUNT_TYPES, canOpen } from '@bhava/app-core/access';

export const TAB_COUNT = 4;
export const TABS = 'tabs';
export const MORE = 'more';
export const SWITCHER = 'switcher';

/** The navigator's name for a feature's screen. */
export const screenName = (feature, screen) => `${feature.name}.${screen.name}`;

/**
 * What this person sees: `tabs` (up to four primary features), `more` (the other features with a menu entry) and
 * `screens` (every screen of every feature they may open, tabs included). `who` is { user, entitlements, accountType }:
 * a creator's account sees what is for creators and for everyone, a seller's what is for sellers and for everyone
 * (a feature says so with `nav.accountTypes`; one that says nothing is for both).
 */
export function buildNavigation(features, who) {
  const open = features.filter((feature) => canOpen(feature, who) && feature.screens.length > 0);
  const menu = open.filter((feature) => feature.nav).sort((a, b) => (a.nav.order ?? 999) - (b.nav.order ?? 999));
  const tabs = menu.filter((feature) => feature.nav.primary).slice(0, TAB_COUNT);
  const more = menu.filter((feature) => !tabs.includes(feature));
  const tabNames = new Set(tabs.map((feature) => screenName(feature, feature.screens[0])));
  const screens = open.flatMap((feature) =>
    feature.screens.map((screen) => {
      const name = screenName(feature, screen);
      return { name, path: screen.path, title: screen.title, component: screen.component, feature: feature.name, inTabs: tabNames.has(name) };
    }),
  );
  return { tabs, more, screens };
}

/**
 * Where a path such as "/orders/12" leads for this person: what to hand `navigation.navigate`, or null when no screen
 * they may open has that path (a link to something their role hides opens nothing).
 */
export function linkTarget(path, { screens }) {
  const hit = matchPath(path, screens);
  if (!hit) return null;
  const screen = screens.find((s) => s.name === hit.name);
  return screen.inTabs ? [TABS, { screen: hit.name, params: hit.params }] : [hit.name, hit.params];
}

/** Problems in the registry itself, as sentences. A test runs this, so a feature that would break the app fails there. */
export function registryProblems(features) {
  const problems = [];
  const names = new Set();
  const paths = new Map();
  for (const feature of features) {
    const where = `features/${feature?.name ?? '?'}`;
    if (!/^[a-z][a-z0-9-]*$/.test(feature?.name ?? '')) problems.push(`${where}: name must be the folder's name, in lower case`);
    if (names.has(feature.name)) problems.push(`${where}: two features have this name`);
    names.add(feature.name);
    const access = feature.access;
    if (!access || !(access.public || access.signedIn || Array.isArray(access.roles))) problems.push(`${where}: access must come from '@bhava/app-core/access'`);
    if (!(feature.feature === null || (typeof feature.feature === 'string' && feature.feature))) problems.push(`${where}: feature is an entitlement name or null`);
    if (!Array.isArray(feature.routeIds) || feature.routeIds.some((id) => typeof id !== 'string' || !id)) problems.push(`${where}: routeIds is a list of route ids and console pages`);
    if (new Set(feature.routeIds).size !== feature.routeIds?.length) problems.push(`${where}: routeIds lists something twice`);
    if (!Array.isArray(feature.screens) || feature.screens.length === 0) problems.push(`${where}: at least one screen`);
    const screenNames = new Set();
    for (const screen of feature.screens ?? []) {
      if (!/^[a-z][A-Za-z0-9]*$/.test(screen?.name ?? '') || screenNames.has(screen.name)) problems.push(`${where}: screen names are unique words`);
      screenNames.add(screen?.name);
      if (typeof screen?.component !== 'function' && typeof screen?.component !== 'object') problems.push(`${where}: screen "${screen?.name}" has no component`);
      if (typeof screen?.title !== 'string' || !screen.title) problems.push(`${where}: screen "${screen?.name}" needs a title key`);
      if (typeof screen?.path === 'string') {
        const shape = screen.path.replace(/:[A-Za-z]+/g, ':');
        if (paths.has(shape)) problems.push(`${where}: path "${screen.path}" is also ${paths.get(shape)}'s`);
        paths.set(shape, where);
        if (!/^([a-z0-9-]+|:[A-Za-z]+)?(\/([a-z0-9-]+|:[A-Za-z]+))*$/.test(screen.path)) problems.push(`${where}: path "${screen.path}" is not like "orders/:id"`);
      }
    }
    if (feature.nav !== null && (typeof feature.nav?.label !== 'string' || typeof feature.nav?.order !== 'number')) problems.push(`${where}: nav is null, or has a label key and an order`);
    const types = feature.nav?.accountTypes;
    if (types !== undefined && (!Array.isArray(types) || types.length === 0 || types.some((type) => !ACCOUNT_TYPES.includes(type)))) problems.push(`${where}: nav.accountTypes lists 'seller', 'creator' or both`);
    for (const locale of ['en', 'hi']) {
      for (const key of Object.keys(feature.strings?.[locale] ?? {})) if (!key.startsWith(`${feature.name}.`)) problems.push(`${where}: string key "${key}" must start with "${feature.name}."`);
    }
  }
  return problems;
}
