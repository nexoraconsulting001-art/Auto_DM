/**
 * The name under the icon. iOS takes it from CFBundleDisplayName (app.config.js); Android has one label for the whole app, so
 * this sets it to the brand's short name, which fits under a launcher icon. The full name stays the store listing's title.
 */
module.exports = function withShortName(config, { shortName } = {}) {
  if (!shortName) return config;
  // Loaded when prebuild runs the plugin, so the config itself reads with no Expo installed.
  const { AndroidConfig, withStringsXml } = require('expo/config-plugins');
  return withStringsXml(config, (mod) => {
    mod.modResults = AndroidConfig.Strings.setStringItem([{ $: { name: 'app_name' }, _: String(shortName) }], mod.modResults);
    return mod;
  });
};
