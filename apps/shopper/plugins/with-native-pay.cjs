/**
 * What the gateway's own SDK needs in the native projects. Added only when the build setting PAY_DRIVER is `native`
 * (app.config.js); react-native.config.js keeps the SDK out of every other build altogether. Not yet tried on a device: see
 * README.md, "Payment".
 *
 *   Android   KEEP_RULES go to the release build's shrinker through expo-build-properties (app.config.js), so the SDK's
 *             classes are neither renamed nor removed
 *   iOS       the app may ask which UPI apps are installed, so the SDK can offer them
 */
const UPI_APPS = ['tez', 'phonepe', 'paytmmp', 'credpay', 'upi'];
const KEEP_RULES = ['-keepattributes *Annotation*', '-dontwarn com.razorpay.**', '-keep class com.razorpay.** { *; }', '-optimizations !method/inlining/', '-keepclasseswithmembers class * { public void onPayment*(...); }'];

// expo/config-plugins is loaded when prebuild runs the plugin, so the config itself reads with no Expo installed.
module.exports = function withNativePay(config) {
  const { withInfoPlist } = require('expo/config-plugins');
  return withInfoPlist(config, (mod) => {
    mod.modResults.LSApplicationQueriesSchemes = [...new Set([...(mod.modResults.LSApplicationQueriesSchemes ?? []), ...UPI_APPS])];
    return mod;
  });
};

module.exports.UPI_APPS = UPI_APPS;
module.exports.KEEP_RULES = KEEP_RULES;
