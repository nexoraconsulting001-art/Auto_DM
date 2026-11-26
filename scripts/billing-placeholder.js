// Fills Bhava's own billing details (the seller on a Bhava invoice) with clearly-marked DUMMY values, so paid plans and
// invoices can be tried in development and demos. Only fields still empty are filled; anything already set is kept.
// Refused in production: there Bhava's team sets the real details in the Platform Console.
//   npm run billing:placeholder
import { pathToFileURL } from 'node:url';
import { config } from '../src/config.js';
import { PLACEHOLDER_BILLING_DETAILS } from '../src/contracts/billing.js';
import { openRuntimeDb } from '../src/db/index.js';

const production = (env) => String(env.NODE_ENV ?? '').trim().toLowerCase() === 'production' || ['production', 'prod'].includes(String(env.DEPLOY_ENV ?? '').trim().toLowerCase());

/** Writes the placeholders into the empty fields. -> the names of the fields it filled */
export async function fillPlaceholderBillingDetails(db, env = process.env) {
  if (production(env)) throw new Error('Placeholder billing details are for development and demos only. Set the real ones in the Platform Console.');
  const q = db.platform ?? db;
  const [row] = await q.query('SELECT * FROM billing_settings LIMIT 1');
  if (!row) throw new Error('billing_settings has no row: run the migrations first.');
  const names = Object.keys(PLACEHOLDER_BILLING_DETAILS).filter((name) => !row[name]);
  if (names.length) {
    await q.query(`UPDATE billing_settings SET ${names.map((name, i) => `${name} = $${i + 1}`).join(', ')}, updated_at = now()`, names.map((name) => PLACEHOLDER_BILLING_DETAILS[name]));
  }
  return names;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const db = await openRuntimeDb(config);
  try {
    const filled = await fillPlaceholderBillingDetails(db);
    console.log(filled.length ? `Filled with PLACEHOLDER values: ${filled.join(', ')}.` : 'Bhava’s billing details were already set. Nothing changed.');
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  } finally {
    await db.close();
  }
}
