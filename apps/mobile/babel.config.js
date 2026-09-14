/**
 * Expo's preset and nothing else.
 *
 * No Reanimated plugin, because TSD 2.1 declares no Reanimated and no Worklets: motion uses
 * React Native's own `Animated`. A plugin for an absent library is a build step that can only
 * fail.
 */
module.exports = function babelConfig(api) {
  api.cache(true);
  return { presets: [['babel-preset-expo', { jsxRuntime: 'automatic' }]] };
};
