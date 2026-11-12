/** `npx jest --config apps/shopper/spec/jest.config.cjs`: the spec tests of the shopper app, written from the PRD, run for both fixture brands. */
const path = require('node:path');

module.exports = require('../../../tools/jest/base.cjs')(path.resolve(__dirname, '..'), {
  displayName: 'shopper-spec',
  testMatch: ['<rootDir>/spec/**/*.test.{js,jsx}'],
});
