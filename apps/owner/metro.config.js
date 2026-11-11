// Metro for the monorepo. Expo's defaults already watch the workspace root and resolve packages from both
// node_modules folders; the app also reads src/contracts (the access rules) from the repository root.
const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

/** @type {import('expo/metro-config').MetroConfig} */
const config = getDefaultConfig(projectRoot);
config.watchFolders = [...new Set([...(config.watchFolders ?? []), workspaceRoot])];
config.resolver.nodeModulesPaths = [...new Set([path.resolve(projectRoot, 'node_modules'), path.resolve(workspaceRoot, 'node_modules'), ...(config.resolver.nodeModulesPaths ?? [])])];
// The server, its tests and the console are never part of the app's bundle or its file watching.
config.resolver.blockList = [/[\/](test|e2e|deploy|console[\/]dist|test-results|\.gate)[\/].*/];

module.exports = config;
