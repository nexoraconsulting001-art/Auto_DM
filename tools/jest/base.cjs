/**
 * The jest setup every app and app package shares: `module.exports = require('../../tools/jest/base.cjs')(__dirname)`.
 * Tests are src/**\/*.test.js(x) beside the code. The setup file refuses any network call that is not to localhost.
 */
const path = require('node:path');

module.exports = (rootDir, extra = {}) => ({
  rootDir,
  displayName: path.basename(rootDir),
  preset: 'jest-expo',
  testMatch: ['<rootDir>/src/**/*.test.{js,jsx}', '<rootDir>/*.test.js'],
  setupFiles: [path.join(__dirname, 'net-guard.cjs')],
  setupFilesAfterEnv: [path.join(__dirname, 'after-env.cjs')],
  // Workspace packages are links to folders outside node_modules, so they are transformed like the app's own code.
  // The icon set ships an ES-module build for React Native; jest takes its CommonJS one.
  moduleNameMapper: {
    '^lucide-react-native$': require.resolve('lucide-react-native'),
    '^lucide-react-native/icons/(.*)$': path.join(path.dirname(require.resolve('lucide-react-native')), 'icons', '$1.js'),
  },
  testPathIgnorePatterns: ['/node_modules/', '/android/', '/ios/', '/dist/'],
  clearMocks: true,
  ...extra,
});
