/**
 * Metro, taught about the monorepo.
 *
 * Two settings and both are load-bearing. `watchFolders` puts the workspace root in Metro's
 * watch set, so a change in `packages/domain` reaches the app without a restart. Disabling
 * `disableHierarchicalLookup` is NOT done - instead `nodeModulesPaths` names both the app's own
 * and the root's, because npm workspaces hoist most packages to the root and Metro would
 * otherwise resolve only what happens to be nested.
 */
const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '..', '..');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];

module.exports = config;
