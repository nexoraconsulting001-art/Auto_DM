import { brandKitRepo } from './repo.js';

export const brand = {
  name: 'brand',
  repos: (db) => ({ brandKit: brandKitRepo(db) }),
};

/** A business's settings with its brand kit attached: what every buyer page renders from. */
export async function buyerSettings(repos) {
  const [settings, kit] = await Promise.all([repos.settings.getAll(), repos.brandKit.get()]);
  return { ...settings, brand: kit };
}
