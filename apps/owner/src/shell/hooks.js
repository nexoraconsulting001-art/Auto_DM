/**
 * useServices and useSession for feature screens. services.js builds the string catalogue from the feature registry,
 * so a feature that imported it at the top would load it while the registry itself is still loading (the registry
 * test loads the features first). These read services.js when a screen draws instead; they are the same hooks.
 */
/* eslint-disable global-require */
export const useServices = () => require('../services.js').useServices();
export const useSession = () => require('../services.js').useSession();
