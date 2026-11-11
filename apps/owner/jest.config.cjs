const base = require('../../tools/jest/base.cjs')(__dirname);

// The spec tests in spec/ (written from the PRD) run beside the app's own src/ tests.
module.exports = { ...base, testMatch: [...base.testMatch, '<rootDir>/spec/**/*.test.{js,jsx}'] };
