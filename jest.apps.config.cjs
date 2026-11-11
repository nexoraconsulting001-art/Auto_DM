/** `npm run test:apps`: jest over the apps and the packages they share, in one run. The server's tests are node:test. */
module.exports = { projects: ['<rootDir>/packages/theme', '<rootDir>/packages/ui', '<rootDir>/packages/app-core', '<rootDir>/apps/owner'] };
