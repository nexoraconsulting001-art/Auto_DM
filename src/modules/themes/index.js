import { themesApi } from './api.js';
import { registerThemePlatformRoutes } from './platform.js';
import { themeSiteReadsRepo } from './repo.js';

export { dominantColor, tuneAccent } from './accent.js';
export { extractLook, lookColors, mapFont, parseColor } from './site-read.js';

/**
 * PRD 5.19, 8.9 and the policy of 5.18: "Pick a look" from the theme presets, the accent tuned from the logo, the seller's seal
 * text and ticker, the theme read from a business's website, and customisation requests. The look is the brand kit
 * (repos.brandKit, migration 304 adds its theme columns); presets are rows with slots from src/contracts/themes.js, drawn by
 * the one buyer layout in src/views/buyer.
 *
 * Also answers platform.themePresets, platform.saveThemePreset and the platform.*CustomisationRequest* routes in platformRoutes.
 */
export const themes = {
  name: 'themes',
  repos: (db) => ({ themeSiteReads: themeSiteReadsRepo(db) }),
  platformRoutes: registerThemePlatformRoutes,
  api: (ctx) => themesApi(ctx ?? {}),
};
