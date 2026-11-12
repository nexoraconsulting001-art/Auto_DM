/**
 * Step 1, load: where the brand comes from.
 *
 *   a path to a brand file   read as it is; its images are the files beside it. Used by CI, by tests and by a developer.
 *   a business's slug        its app config, brand kit and images from the database (app_configs, brand kit, media), turned
 *                            into the same shape. Filled by the pipeline track through `options.loadBySlug(slug, state)`,
 *                            which answers { brand, sourceDir } or { config, kit, hosts, sourceDir }.
 *
 * In:  state.input
 * Out: { source: 'file' | 'database', brand?, config?, kit?, hosts?, sourceDir }
 */
import fs from 'node:fs';
import path from 'node:path';
import { BuildBrandError, notBuilt } from '../errors.mjs';

export const name = 'load';

const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** True when the input names a file rather than a business. */
export const isBrandFilePath = (input) => /[\\/]|\.json$/i.test(String(input));

export async function run(state, { options }) {
  const input = String(state.input ?? '').trim();
  if (!input) throw new BuildBrandError({ step: name, code: 'no_input', message: 'Name a business by its slug, or give the path of a brand file.' });
  if (isBrandFilePath(input)) {
    const file = path.resolve(options.cwd, input);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new BuildBrandError({ step: name, code: 'no_brand_file', message: `There is no brand file named ${path.basename(file)} there.` });
    let brand;
    try {
      brand = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      throw new BuildBrandError({ step: name, code: 'bad_brand_file', message: 'The brand file is not valid JSON.' });
    }
    return { source: 'file', brand, sourceDir: path.dirname(file) };
  }
  if (!SLUG.test(input)) throw new BuildBrandError({ step: name, code: 'bad_slug', message: 'A business is named by its slug: lower-case letters, digits and dashes.' });
  if (typeof options.loadBySlug !== 'function') throw notBuilt(name, 'Loading a brand from the database by its slug');
  return { source: 'database', ...(await options.loadBySlug(input, state)) };
}
