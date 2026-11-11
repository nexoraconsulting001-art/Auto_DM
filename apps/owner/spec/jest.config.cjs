/**
 * The owner app's spec tests (PRD 10.2 to 10.6, written from the PRD and the contract): jest-expo with Testing Library,
 * on the same shared setup as the app's own tests. apps/owner/jest.config.cjs matches src/ only, so these are run with
 *
 *   npx jest --config apps/owner/spec/jest.config.cjs
 *
 * until that config also matches <rootDir>/spec (the integrator's change: this folder may not edit it).
 */
const path = require('node:path');

const owner = path.resolve(__dirname, '..');
const base = require('../../../tools/jest/base.cjs')(owner);

module.exports = { ...base, displayName: 'owner-spec', testMatch: ['<rootDir>/spec/**/*.test.{js,jsx}'] };
