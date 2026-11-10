import { notBuilt } from '../not-built.js';

/**
 * PRD 5.19, 8.9 and the policy of 5.18: "Pick a look" from the theme presets, the accent tuned from the logo, the seller's seal
 * text and ticker, the theme read from a business's website, and customisation requests. The look is the brand kit
 * (repos.brandKit, migration 304 adds its theme columns); presets are rows with slots from src/contracts/themes.js.
 *
 * Also answers platform.themePresets, platform.saveThemePreset and the platform.*CustomisationRequest* routes in platformRoutes.
 */
export const themes = {
  name: 'themes',
  api: () => notBuilt('themes.presets', 'themes.get', 'themes.choose', 'themes.updateText', 'themes.readSite', 'themes.siteReads', 'themes.applySiteRead'),
};
