/**
 * Step 4, write the brand file: one folder per run holding brand.json and its images, which is everything apps/shopper's
 * app.config.js reads (through the BRAND_FILE setting). The folder is `.brand-builds/t<business id>/`, ignored by git, so no
 * brand ever lands in apps/ or packages/.
 *
 *   from a file         the brand file is written out again in the schema's own shape, with the pay driver this run asked for
 *   from the database   the brand is made from the config, the kit, the next build numbers and the link hosts. Filled by the
 *                       pipeline track through `options.makeBrand(state)`, which answers the brand object.
 *
 * In:  state.brand, state.assets, state.fonts
 * Out: { brand, brandDir, brandFile }
 */
import fs from 'node:fs';
import path from 'node:path';
import { BrandFile } from '../../../src/contracts/apps.js';
import { BuildBrandError, notBuilt } from '../errors.mjs';

export const name = 'brand_file';

export async function run(state, { options }) {
  let brand = state.brand;
  if (!brand) {
    if (typeof options.makeBrand !== 'function') throw notBuilt(name, 'Making a brand file from a business’s app config');
    brand = await options.makeBrand(state);
  }
  if (options.payDriver) brand = { ...brand, payDriver: options.payDriver };
  const parsed = BrandFile.safeParse(brand);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new BuildBrandError({ step: name, code: 'invalid', field: issue.path.join('.') || null, message: `${issue.path.join('.') || 'The brand file'}: ${issue.message}` });
  }
  const brandDir = path.resolve(options.cwd, options.outDir, `t${parsed.data.tenantId}`);
  fs.rmSync(brandDir, { recursive: true, force: true });
  fs.mkdirSync(brandDir, { recursive: true });
  for (const [key, file] of Object.entries(state.assets)) fs.copyFileSync(file, path.join(brandDir, parsed.data.assets[key]));
  if (state.fonts?.length) {
    fs.mkdirSync(path.join(brandDir, 'fonts'));
    for (const font of state.fonts) fs.copyFileSync(font, path.join(brandDir, 'fonts', path.basename(font)));
  }
  const brandFile = path.join(brandDir, 'brand.json');
  fs.writeFileSync(brandFile, `${JSON.stringify(parsed.data, null, 2)}\n`);
  return { brand: parsed.data, brandDir, brandFile };
}
