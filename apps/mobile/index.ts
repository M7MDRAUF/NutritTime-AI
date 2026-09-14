/**
 * The Expo entry point.
 *
 * `registerRootComponent` rather than `AppRegistry.registerComponent`: it is the call Expo's
 * own bundler expects, and it also wires the web entry, which `output: "static"` in app.json
 * depends on.
 */
import { registerRootComponent } from 'expo';
import App from './App.js';

registerRootComponent(App);
