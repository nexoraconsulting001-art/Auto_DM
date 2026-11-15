/**
 * `node tools/review-pack/index.mjs`: checks the go-live pack in docs/go-live against the code (G-18 to G-20). Exits 1 and
 * names each problem when the code asks for a permission the pack does not cover, the pack justifies one the code no longer
 * asks for, a listing is over a store's limit or makes a banned claim, a privacy answer has drifted from the apps'
 * declared permissions and data, or a document holds a secret or a real account id. Sends nothing; submits nothing.
 *
 *   node tools/review-pack/index.mjs           the check
 *   node tools/review-pack/index.mjs --write   first rewrites the generated documents (see lib.mjs generatedFiles)
 */
import { pathToFileURL } from 'node:url';
import { ROOT, checkPack, writeGenerated } from './lib.mjs';

export async function main(argv = process.argv.slice(2), root = ROOT) {
  if (argv.includes('--write')) for (const file of await writeGenerated(root)) console.log(`wrote ${file}`);
  const problems = await checkPack(root);
  for (const problem of problems) console.error(problem);
  if (problems.length) {
    console.error(`\nreview-pack: ${problems.length} problem(s). The go-live pack must match the code.`);
    return 1;
  }
  console.log('review-pack: the pack covers every permission the code asks for and nothing else; listings, privacy answers and documents agree with the apps.');
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();
