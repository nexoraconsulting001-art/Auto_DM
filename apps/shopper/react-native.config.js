// The gateway's SDK is linked into the native projects only when the build setting PAY_DRIVER is `native` (README.md,
// "Payment"). Every other build leaves it out altogether: no native code, no generated code, nothing in the binary.
// Set PAY_DRIVER the same way for prebuild and for the Gradle or Xcode build that follows; `npm run build-brand` does.
const nativePay = process.env.PAY_DRIVER === 'native';

module.exports = {
  dependencies: nativePay ? {} : { 'react-native-razorpay': { platforms: { android: null, ios: null } } },
};
